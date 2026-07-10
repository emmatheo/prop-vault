// prop-vault: pari-mutuel World Cup prop markets, trustlessly settled by
// CPI into TxLINE's `validate_stat` (Merkle-proof verification on Solana).
//
// Counterparty model: pari-mutuel. All YES stakes vs all NO stakes in one
// USDC vault. Winners split the losing pool pro-rata. There is ALWAYS a
// counterparty; no order book, no AMM curve. (Say this in the demo video.)
//
// DAY-1 TASKS (cannot be done offline):
//  1. `anchor keys sync` and replace declare_id below.
//  2. Download the TxLINE *devnet* IDL from
//     https://txline.txodds.com/documentation/programs/devnet
//     into idls/txoracle.json — `declare_program!` generates the CPI module
//     and types from it. Field names in ValidateStatArgs below MUST be
//     reconciled against that IDL (names here follow their docs examples).
//  3. Check the IDL's operator enum: docs demonstrate `subtract`. If `add`
//     exists, TOTAL_GOALS_OVER markets work; if not, restrict to single-stat
//     and subtract-based props (winner, team corners over, etc).

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("AudqCpevyJj4FFXnJQsdkFaj1FMFqMhYNZ9SEN37Cc9q"); // replace after `anchor keys sync`

// TxLINE devnet program (from docs: programs/addresses)
pub const TXORACLE_DEVNET: &str = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J";

// Generates txoracle::cpi::validate_stat + account/arg types from the IDL.
declare_program!(txoracle);

pub const BPS_DENOM: u64 = 10_000;
pub const PROTOCOL_FEE_BPS: u64 = 100; // 1% rake on winnings; monetization story

#[program]
pub mod prop_vault {
    use super::*;

    /// Create a binary market whose YES outcome is a TxLINE predicate.
    /// Examples:
    ///   Home win .......... stat_key=1, stat_key2=Some(2), op=Subtract, threshold=0, cmp=GreaterThan
    ///   Home corners > 5.5  stat_key=7, stat_key2=None,   threshold=5, cmp=GreaterThan
    pub fn create_market(
        ctx: Context<CreateMarket>,
        market_id: u64,
        fixture_id: u64,
        stat_key: u16,
        stat_key2: Option<u16>,
        op: u8,          // 0 = none, 1 = subtract, 2 = add (matches txoracle BinaryExpression)
        threshold: i32,  // TraderPredicate.threshold is i32 per IDL
        period: i32,     // ScoreStat.period to settle on (0 = full match)
        cmp: u8,         // 0 = GreaterThan, 1 = LessThan, 2 = EqualTo
        lock_ts: i64,    // kickoff: no stakes after this
        settle_after_ts: i64, // scheduled end + buffer: no settlement before this
        void_after_ts: i64,   // if unsettled by this (abandoned/postponed), refunds open
        question: [u8; 64],   // utf8, zero-padded; shown in receipts
    ) -> Result<()> {
        require!(lock_ts < settle_after_ts && settle_after_ts < void_after_ts, VaultError::BadTimeline);
        let m = &mut ctx.accounts.market;
        m.authority = ctx.accounts.authority.key();
        m.market_id = market_id;
        m.fixture_id = fixture_id;
        m.stat_key = stat_key;
        m.stat_key2 = stat_key2.unwrap_or(0);
        m.op = op;
        m.threshold = threshold;
        m.period = period;
        m.cmp = cmp;
        m.lock_ts = lock_ts;
        m.settle_after_ts = settle_after_ts;
        m.void_after_ts = void_after_ts;
        m.question = question;
        m.yes_pool = 0;
        m.no_pool = 0;
        m.state = MarketState::Open as u8;
        m.outcome_yes = false;
        m.vault_bump = ctx.bumps.market;
        Ok(())
    }

    /// Stake USDC on YES or NO before kickoff.
    pub fn stake(ctx: Context<Stake>, side_yes: bool, amount: u64) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.state == MarketState::Open as u8, VaultError::NotOpen);
        require!(Clock::get()?.unix_timestamp < m.lock_ts, VaultError::MarketLocked);
        require!(amount > 0, VaultError::ZeroAmount);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_usdc.to_account_info(),
                    to: ctx.accounts.vault_usdc.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        let p = &mut ctx.accounts.position;
        p.owner = ctx.accounts.user.key();
        p.market = m.key();
        if side_yes {
            p.yes_amount = p.yes_amount.checked_add(amount).unwrap();
            m.yes_pool = m.yes_pool.checked_add(amount).unwrap();
        } else {
            p.no_amount = p.no_amount.checked_add(amount).unwrap();
            m.no_pool = m.no_pool.checked_add(amount).unwrap();
        }
        Ok(())
    }

    /// Permissionless settlement. Anyone (our keeper, a judge, a rival) can
    /// call this after settle_after_ts with the TxLINE proof bundle fetched
    /// from /api/scores/stat-validation. The market's stored predicate is
    /// proven true or false ON-CHAIN via CPI — this instruction never trusts
    /// the caller's claim, only the Merkle proof against TxLINE's daily root.
    ///
    /// KEEP THIS INSTRUCTION THIN: validate_stat needs up to ~1.4M CU in
    /// docs' own budget. Client must attach ComputeBudget max units.
    pub fn settle(
        ctx: Context<Settle>,
        target_ts: i64,
        fixture_summary: txoracle::types::ScoresBatchSummary,
        fixture_proof: Vec<txoracle::types::ProofNode>,
        main_tree_proof: Vec<txoracle::types::ProofNode>,
        stat_a: txoracle::types::StatTerm,
        stat_b: Option<txoracle::types::StatTerm>,
    ) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.state == MarketState::Open as u8, VaultError::NotOpen);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= m.settle_after_ts, VaultError::TooEarly);

        // Guard 1: the proof must describe THIS fixture...
        require!(fixture_summary.fixture_id == m.fixture_id as i64, VaultError::WrongFixture);
        // ...and its update window must extend past the match-end gate, so a
        // mid-match snapshot (e.g. 1-0 at half time) can't settle the market.
        // TxLINE timestamps are milliseconds.
        require!(
            fixture_summary.update_stats.max_timestamp >= m.settle_after_ts.saturating_mul(1000),
            VaultError::StaleProof
        );

        // Guard 2 (critical): the caller supplies the ScoreStat leaves being
        // proven. Without these checks a settler could prove a *corners* stat
        // against a *goals* market, or a first-half period against full-time,
        // and still satisfy the predicate. Pin key + period to market params.
        require!(stat_a.stat_to_prove.key == m.stat_key as u32, VaultError::StatKeyMismatch);
        require!(stat_a.stat_to_prove.period == m.period, VaultError::PeriodMismatch);
        match (&stat_b, m.stat_key2) {
            (Some(b), k2) if k2 != 0 => {
                require!(b.stat_to_prove.key == k2 as u32, VaultError::StatKeyMismatch);
                require!(b.stat_to_prove.period == m.period, VaultError::PeriodMismatch);
            }
            (None, 0) => {}
            _ => return err!(VaultError::StatCountMismatch),
        }

        // Rebuild predicate/op from stored market params (never caller input).
        let predicate = txoracle::types::TraderPredicate {
            threshold: m.threshold,
            comparison: match m.cmp {
                0 => txoracle::types::Comparison::GreaterThan,
                1 => txoracle::types::Comparison::LessThan,
                _ => txoracle::types::Comparison::EqualTo,
            },
        };
        let op = match (m.stat_key2, m.op) {
            (0, _) => None,
            (_, 1) => Some(txoracle::types::BinaryExpression::Subtract),
            (_, _) => Some(txoracle::types::BinaryExpression::Add),
        };

        let cpi_ctx = CpiContext::new(
            ctx.accounts.txoracle_program.to_account_info(),
            txoracle::cpi::accounts::ValidateStat {
                daily_scores_merkle_roots: ctx.accounts.daily_scores_merkle_roots.to_account_info(),
            },
        );
        txoracle::cpi::validate_stat(
            cpi_ctx,
            target_ts,
            fixture_summary,
            fixture_proof,
            main_tree_proof,
            predicate,
            stat_a,
            stat_b,
            op,
        )?;
        let (_, ret) = anchor_lang::solana_program::program::get_return_data()
            .ok_or(VaultError::NoReturnData)?;
        let outcome_yes = ret.first().copied().unwrap_or(0) == 1;

        // Degenerate pools: if the winning side is empty, void instead of
        // trapping the losing side's funds.
        let winning_pool = if outcome_yes { m.yes_pool } else { m.no_pool };
        if winning_pool == 0 {
            m.state = MarketState::Voided as u8;
        } else {
            m.outcome_yes = outcome_yes;
            m.state = MarketState::Settled as u8;
        }
        m.settled_ts = now;
        emit!(SettledEvent { market: m.key(), fixture_id: m.fixture_id, outcome_yes, target_ts });
        Ok(())
    }

    /// Abandoned / cancelled / postponed safety valve: if nobody could settle
    /// by void_after_ts, flip to refunds. Permissionless.
    pub fn void(ctx: Context<Void>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.state == MarketState::Open as u8, VaultError::NotOpen);
        require!(Clock::get()?.unix_timestamp >= m.void_after_ts, VaultError::TooEarly);
        m.state = MarketState::Voided as u8;
        Ok(())
    }

    /// Winner payout = own_winning_stake + own_share_of_losing_pool − 1% fee
    /// on the winnings portion only. Voided market: full refund of all stakes.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let m = &ctx.accounts.market;
        let p = &mut ctx.accounts.position;
        require!(!p.claimed, VaultError::AlreadyClaimed);

        let payout: u64 = match m.state {
            s if s == MarketState::Voided as u8 => p.yes_amount + p.no_amount,
            s if s == MarketState::Settled as u8 => {
                let (my_stake, win_pool, lose_pool) = if m.outcome_yes {
                    (p.yes_amount, m.yes_pool, m.no_pool)
                } else {
                    (p.no_amount, m.no_pool, m.yes_pool)
                };
                if my_stake == 0 { 0 } else {
                    let winnings = (my_stake as u128 * lose_pool as u128 / win_pool as u128) as u64;
                    let fee = winnings * PROTOCOL_FEE_BPS / BPS_DENOM;
                    my_stake + winnings - fee
                }
            }
            _ => return err!(VaultError::NotSettled),
        };
        require!(payout > 0, VaultError::NothingToClaim);
        p.claimed = true;

        let market_id = m.market_id;
        let seeds: &[&[u8]] = &[b"market", &market_id.to_le_bytes(), &[m.vault_bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_usdc.to_account_info(),
                    to: ctx.accounts.user_usdc.to_account_info(),
                    authority: m.to_account_info(),
                },
                &[seeds],
            ),
            payout,
        )?;
        Ok(())
    }
}

// ---------- accounts ----------

#[account]
pub struct Market {
    pub authority: Pubkey,
    pub market_id: u64,
    pub fixture_id: u64,
    pub stat_key: u16,
    pub stat_key2: u16, // 0 = none
    pub op: u8,
    pub threshold: i32,
    pub period: i32, // ScoreStat period this market settles on (0 = full match; verify vs soccer-feed docs)
    pub cmp: u8,
    pub lock_ts: i64,
    pub settle_after_ts: i64,
    pub void_after_ts: i64,
    pub settled_ts: i64,
    pub question: [u8; 64],
    pub yes_pool: u64,
    pub no_pool: u64,
    pub state: u8,
    pub outcome_yes: bool,
    pub vault_bump: u8,
}
impl Market { pub const SIZE: usize = 8 + 32 + 8 + 8 + 2 + 2 + 1 + 4 + 4 + 1 + 8*4 + 64 + 8 + 8 + 1 + 1 + 1 + 16; }

#[account]
pub struct Position {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub yes_amount: u64,
    pub no_amount: u64,
    pub claimed: bool,
}
impl Position { pub const SIZE: usize = 8 + 32 + 32 + 8 + 8 + 1 + 8; }

#[derive(Clone, Copy)]
pub enum MarketState { Open = 0, Settled = 1, Voided = 2 }

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct CreateMarket<'info> {
    #[account(init, payer = authority, space = Market::SIZE,
        seeds = [b"market", market_id.to_le_bytes().as_ref()], bump)]
    pub market: Account<'info, Market>,
    #[account(init, payer = authority,
        associated_token::mint = usdc_mint, associated_token::authority = market)]
    pub vault_usdc: Account<'info, TokenAccount>,
    /// CHECK: USDC mint, pinned in client config
    pub usdc_mint: AccountInfo<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(init_if_needed, payer = user, space = Position::SIZE,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()], bump)]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub user_usdc: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = user_usdc.mint, associated_token::authority = market)]
    pub vault_usdc: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
    /// CHECK: TxLINE daily_scores_merkle_roots PDA for the proof's epoch day;
    /// validated by the txoracle program itself during CPI (InvalidPda otherwise).
    pub daily_scores_merkle_roots: AccountInfo<'info>,
    /// CHECK: pinned to TxLINE program id
    #[account(address = TXORACLE_DEVNET.parse::<Pubkey>().unwrap())]
    pub txoracle_program: AccountInfo<'info>,
    pub cranker: Signer<'info>,
}

#[derive(Accounts)]
pub struct Void<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
    pub cranker: Signer<'info>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(seeds = [b"market", market.market_id.to_le_bytes().as_ref()], bump = market.vault_bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"position", market.key().as_ref(), user.key().as_ref()], bump,
        constraint = position.owner == user.key())]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub user_usdc: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = user_usdc.mint, associated_token::authority = market)]
    pub vault_usdc: Account<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[event]
pub struct SettledEvent {
    pub market: Pubkey,
    pub fixture_id: u64,
    pub outcome_yes: bool,
    pub target_ts: i64,
}

#[error_code]
pub enum VaultError {
    #[msg("timeline must be lock < settle_after < void_after")] BadTimeline,
    #[msg("market is not open")] NotOpen,
    #[msg("market locked at kickoff")] MarketLocked,
    #[msg("zero amount")] ZeroAmount,
    #[msg("too early")] TooEarly,
    #[msg("proof is for a different fixture")] WrongFixture,
    #[msg("proof window ends before match end; mid-match proofs rejected")] StaleProof,
    #[msg("validate_stat returned no data")] NoReturnData,
    #[msg("proven stat key does not match market stat key")] StatKeyMismatch,
    #[msg("proven stat period does not match market period")] PeriodMismatch,
    #[msg("stat count does not match market definition")] StatCountMismatch,
    #[msg("market not settled")] NotSettled,
    #[msg("already claimed")] AlreadyClaimed,
    #[msg("nothing to claim")] NothingToClaim,
}
