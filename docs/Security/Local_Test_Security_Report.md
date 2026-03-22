## 🌀 ARAF PROTOCOL — COMPREHENSIVE FUTURE PLAN AND TECHNICAL DEBT REPORT
> Document Type: Security Audit & Technical Debt Assessment
 Status: Local Test / Pending Mitigation
---
### PART 1: CORE ARCHITECTURE AND FUTURE PLAN ROADMAP
Fundamental protocol updates aimed at maximizing technical maturity, security, and the "unmanned, oracle-independent" philosophy.
1. PII Snapshot and "Bait-and-Switch" Protection
Goal: Prevent parties from misleading each other by modifying profile information after a transaction is locked, ensuring full autonomy.
 * Vulnerability: Currently, IBAN and name data are fetched live from the User table. If a party changes their details after the trade status becomes LOCKED, it leads to misdirected payments or unjustified disputes.
 * Solution (On-Lock Snapshot): Implement a mechanism to freeze data the moment a transaction is locked.
 * Action Items:
   * models/Trade.js: Add a pii_snapshot object (maker_bankOwner_enc, maker_iban_enc, taker_bankOwner_enc, captured_at) and a snapshot_delete_at field for automated purging.
   * routes/trades.js: Copy data from the User document to the Trade document when the on-chain LOCKED state is triggered.
   * routes/pii.js: Revise GET /api/pii/:tradeId and taker-name endpoints to read from the snapshot data.
2. User Experience and Onboarding (Tier 0)
Goal: Lower entry barriers for new users and increase transparency.
 * 7-Day Registration Barrier: The mandatory WALLET_AGE_MIN (7 days) rule for Tier 0 disrupts the onboarding flow; an "instant" usage capability must be designed for new users.
 * Dust Limit Obstacle: The mandatory balance of 0.001 ETH (~$2-3) creates a disproportionately high entry cost for small Tier 0 trades (e.g., 10 USDT).
 * Cooldown Ambiguity: The 4-hour cooldown period for Tier 0/1 must be displayed with a dynamic timer on the UI.
3. Security and Game Theory Analytics
Goal: Maintain economic deterrence and prevent system manipulation.
 * Tier 0 Costless Extortion Risk: Since the Taker bond is 0%, malicious buyers can open disputes at no cost and drain the Maker's funds (USDT_DECAY).
 * Race Condition (Ping Conflict): The UI cannot handle the ConflictingPingPath error that occurs if autoRelease and challengeTrade processes are initiated simultaneously.
 * PII Validation Guard: Makers must not be allowed to open a listing without entering bank details; otherwise, Takers will encounter empty data and deadlock the process.
 * Mempool Sniping (Front-running): Technical countermeasures must be evaluated against the risk of a Taker front-running a Maker's cancelOpenEscrow transaction spotted in the mempool.
4. Technical, Software, and Synchronization Errors
Goal: Ensure data consistency and strengthen UI/Blockchain synchronization.
 * State and Polling: chargebackAccepted state must be restored from the backend on page reload. The polling rate (15 sec) should be optimized for critical dispute moments.
 * Event Listener Latency: The retry loop (12 sec) in handleStartTrade might be insufficient; the confirmation mechanism must be strengthened to prevent PIIDisplay 404 errors.
 * Precision Loss: Shift from JavaScript's Number type to BigInt-based calculations using viem's parseUnits.
 * Dynamic Decimals: Instead of hardcoding decimals = 6, the decimals() value must be fetched dynamically from the contract.
 * Clock Drift: A "safety margin" must be added to timers to prevent premature trigger errors caused by discrepancies between the user's local time and blockchain time.
5. Authentication, Privacy, and PII Management
Goal: Ensure GDPR compliance and protect sensitive data.
 * Logout Endpoint: Add a logout API call that invalidates JWTs and refresh tokens on the backend.
 * PII Token Insensitivity: The PII token must be invalidated immediately once a trade becomes CANCELED.
 * XSS Protection: taker-name and piiBankOwner data must be sanitized against XSS attacks before rendering.
 * Sensitive Data Cleanup: To prevent memory residue, PII states must be cleared more aggressively upon component unmount. Evidence retention period (30 days) should be re-evaluated for chargeback scenarios.
6. Admin Panel and Operational Risks
Goal: Restrict admin privileges to make the system fully autonomous.
 * Admin Role: Admin should be downgraded from "Decision Maker" to "Observer/Evidence Provider"; IBAN correction privileges must be removed.
 * DB Synchronization: When handleDeleteOrder executes an on-chain cancellation, it must also delete the listing in the backend database.
 * Token List Management: When a token is delisted (setSupportedToken), revert guards must be checked for the risk of locking funds in active trades.
### PART 2: LOGIC FLAWS, WALLET, AND UI (APP.JSX) FINDINGS
1. Loss of "Audit Trail" in Cancellation Process
 * Discovery: In the /propose-cancel endpoint (trades.js), the initiator is recorded via trade.cancel_proposal.proposed_by = req.wallet. However, when the second party approves, this field is overwritten by the approver's address.
 * Logic Flaw: The information about who actually initiated the cancellation is lost (overwritten) in the database.
 * Risk: In dispute analysis or reputation calculations, it becomes impossible to identify users who harass sellers with constant cancel proposals.
 * Recommendation: proposed_by should only be set on the initial proposal; the second party's approval must be stored in a separate approved_by field.
2. "Unused Allowance Garbage" Issue
 * Discovery: handleStartTrade (Taker) and handleCreateEscrow (Maker) in App.jsx call approveToken first, then execute the contract transaction.
 * Technical Risk: If the user approves the transaction in their wallet but closes the window during the lockEscrow/createEscrow step, or if the transaction fails, the "spending allowance" remains open on the contract.
 * Security Impact: The contract retains authorization to pull tokens from the user's wallet even if the trade never happened.
 * Recommendation: Add a "cleanup" step in the catch block to reset the allowance to 0 for user safety upon failure.
3. Unprotected PII Input Type and Length
 * Discovery: App.jsx only trims spaces when capturing piiIban and piiBankOwner.
 * Data Integrity Risk: A user could input 500 characters of random text into the IBAN field. This can cause database bloat or buffer errors during decryption on the backend.
 * Risk: If improperly formatted data (e.g., incomplete IBAN) is locked, the Taker cannot send funds, forcing the trade into a CHALLENGED state.
 * Recommendation: Enforce regex (/^TR\d{24}$/) for IBAN and strict character limits for names on the frontend.
4. "Orphaned Listings" and DB Synchronization
 * Discovery: handleDeleteOrder successfully calls cancelOpenEscrow on-chain but only updates the local state (setOrders).
 * Logic Flaw: There is no API request calling the DELETE /api/listings/:id route on the backend.
 * Risk: While the user thinks they deleted their listing, it remains OPEN in MongoDB. Other users will see this "ghost listing," attempt to buy it, and waste gas fees or receive errors because it no longer exists on-chain.
 * Recommendation: An API call must be made to delete the listing from the backend DB immediately after a successful on-chain cancellation.
5. Polling and State Conflict (Race Condition)
 * Discovery: App.jsx updates all trades every 15 seconds via fetchMyTrades.
 * Technical Risk: If the 15-second background polling triggers at the exact second a user clicks handleRelease and the transaction is sent to the blockchain, the UI state might be overwritten with stale, unconfirmed data.
 * UX Flaw: The user might click the button again thinking it didn't work, leading to a 409 error on the chargeback-ack endpoint or unnecessary wallet popups.
 * Recommendation: Temporarily pause the polling mechanism (isContractLoading state) whenever a contract write operation begins; manually trigger a fetch once the transaction completes.
6. "One-Way Road": maxAllowedTier Lock
 * Discovery: According to the architecture and contract logic, maxAllowedTier is permanently lowered when a user is banned.
 * Logic Flaw: decayReputation only resets consecutiveBans; there is no mechanism defined in the contract or docs to raise a diminished maxAllowedTier.
 * Risk: If a user drops from Tier 4 to Tier 1, they technically can never return to Tier 2, 3, or 4, even after 1,000 successful trades. "Forgiveness" exists, but "rank restoration" is functionally missing.
 * Recommendation: Introduce an autonomous "Promotion" logic that increments maxAllowedTier after a specific number of successful transactions.
7. IPFS Receipt Content and "Junk Data" Abuse
 * Discovery: reportPayment expects an ipfsHash (receipt) from the Taker and records it on-chain unconditionally.
 * Technical Risk: Although file upload is mandatory in App.jsx, a user can interact with the contract directly, send a random string or empty string, and transition the trade to PAID.
 * Impact: The Maker sees a broken image or empty link in the trade room. This sabotages the "Admin Evidence" process and traps the honest seller in a CHALLENGED state.
 * Recommendation: The backend must verify that the IPFS hash points to a valid image file during upload and grant "valid evidence" approval before it is sent to the contract.
8. Gas Fee Spikes and UI "Freeze" Illusion
 * Discovery: waitForTransactionReceipt is utilized within useArafContract.js.
 * Technical Risk: If gas fees spike on the Base network, the user's transaction gets stuck in the mempool.
 * UX Flaw: The UI shows a loading spinner. If it takes minutes and the user refreshes, txHash is wiped from the local state. The user loses tracking capability and assumes the system "froze."
 * Recommendation: Persist txHash in localStorage the moment the transaction is sent, allowing waitForTransactionReceipt to resume even if the page is reloaded.
9. SIWE Session Duration vs. "Bleeding" Timing
 * Discovery: JWT (session) lifespan is set to 15 minutes.
 * Logic Flaw: The "Bleeding Escrow" (dispute) phase can last for days.
 * Risk: A user monitoring the critical "bleeding" seconds of their trade might have their session expire abruptly. If the Base network is slow or they delay re-signing via SIWE, they might miss the window for critical actions (e.g., pingMaker).
 * Recommendation: Implement an "extended session" logic for users who have active trades (LOCKED, PAID, CHALLENGED).
10. "Multi-Token" Display and Unit Confusion
 * Discovery: getTrade in useArafContract.js returns cryptoAmount as uint256 (wei).
 * UI Flaw: If the "Trade Room" formats every token assuming 6 decimals (like USDT), adding an 18-decimal token (like DAI) will cause a 1000 DAI trade to display as 0.000000000001 DAI.
 * Impact: Severe user panic and confusion regarding transaction amounts.
 * Recommendation: The renderTradeRoom component must fetch the decimals value for the specific tokenAddress from the contract or cache before formatting the amount.
### PART 3: PRIVACY, PII, AND SIWE SECURITY VECTORS
1. PII Harvesting and Data Scraping Risk
 * Discovery: Currently, a Taker gains access to the Maker's PII (IBAN and Name) the moment they lock the listing (lockEscrow).
 * Technical Risk: A malicious user can target high-tier listings (Tier 3-4), lock them, scrape the PII data, and then attempt to cancel (proposeCancel) or abandon the trade without paying.
 * Impact: The system becomes an open door for "data hunters" looking to harvest the real identities and banking details of professional sellers.
 * Recommendation: Locking a bond should not be enough to reveal PII. Require a secondary on-chain approval from the Maker ("Reveal Data") after reviewing the Taker's reputation, or impose a time-delay on PII access after LOCKED.
2. SIWE JWT and Wallet Swap Desync (Session Hijacking Guard)
 * Discovery: A JWT is stored in the browser after SIWE login.
 * Technical Risk: A user can switch their wallet to "Wallet B" in MetaMask, but the JWT in the browser remains tied to "Wallet A". Hook states (useAccount) update to Wallet B, but authenticatedFetch sends requests authorized as Wallet A.
 * Impact: The user thinks they are acting as Wallet B, but they can view Wallet A's listings or access PII data on the backend. This leads to Broken Access Control and severe UI desynchronization.
 * Recommendation: Implement a "Watch" mechanism in App.jsx that immediately clears the JWT and forces a re-signature (SIWE) the moment the wallet address changes.
3. Price Staleness and Arbitrage Risk
 * Discovery: exchange_rate is fixed when a Maker opens a listing.
 * Logic Flaw: USDT/TRY prices can change in seconds. If a listing remains OPEN for 2 days, a massive delta can form against market price.
 * Risk: Arbitrageurs will instantly lock outdated (cheap) listings, causing financial loss to the Maker. If the Maker refuses to trade, they lose reputation and risk their bond.
 * Recommendation: Add an "Expiry Date" to listings, or implement a pre-lock market price check in App.jsx that warns the Maker: "Your price is significantly below market, do you want to update?"
4. Bank Daily Limit "Blindness"
 * Discovery: The protocol knows on-chain limits (Tiers) but is blind to users' daily Fiat EFT/Wire limits at their actual banks.
 * Logic Flaw: A Maker might have Tier 4 on-chain clearance (30,000+ USDT), but their bank limit for the day is exhausted.
 * Risk: Taker locks the listing and deposits funds. Maker cannot send/receive the fiat. The trade goes to CHALLENGED and both parties bleed funds.
 * Recommendation: Add a "Bank Limit Reached / Inactive" toggle for Makers on the UI; turning this off should temporarily switch their listings to PAUSED.
5. RPC Provider Outage and "Local UI" Crash
 * Discovery: useArafContract.js utilizes a single publicClient.
 * Technical Risk: If the primary Base RPC provider (e.g., Ankr, Infura) experiences an outage, all readContract calls in App.jsx will throw errors.
 * Impact: If a user sees "Contract Cannot Be Read" while their funds are locked, they will panic, potentially execute erroneous transactions, or lose track of Bleeding Escrow timers.
 * Recommendation: Define multiple RPC providers (Fallback Provider array) in useArafContract.js to ensure UI continuity.
### PART 4: CONCURRENCY AND BACKGROUND PROCESSES
1. Nonce Desync in Cancellation Signatures (Concurrency Risk)
 * Discovery: signCancelProposal in useArafContract.js reads sigNonces directly from the contract at that moment for EIP-712 signatures.
 * Technical Risk: If a user has two active trades and tries to sign "Cancel Proposals" for both simultaneously, the contract returns the identical nonce for both signatures.
 * Impact: When the first signature is confirmed on-chain, the nonce increments. The second signature (pending or sent) will revert due to a nonce mismatch. The user experiences a "Signed but failed" paradox.
 * Recommendation: The backend must track "pending/unused nonces" per user, or the UI must restrict multiple simultaneous signature flows.
2. Browser Throttling and Timer Drift
 * Discovery: The useCountdown hook likely uses standard setInterval.
 * Technical Risk: Modern browsers (Chrome, Safari) throttle background tab JavaScript timers to 1 execution per second or halt them entirely.
 * Risk: If a user backgrounds the tab while waiting for a 48-hour autoRelease, the UI timer will drift minutes behind the on-chain time.
 * Recommendation: Instead of relying on local tick deltas, sync the "time remaining" calculation with on-chain block.timestamp references at regular intervals.
3. "Partial Allowance" Leak
 * Discovery: handleCreateEscrow and handleStartTrade call approveToken for totalLock right before triggering the main contract function.
 * Technical Risk: If approveToken succeeds but the user cancels the MetaMask popup for the main transaction (or it fails due to gas), the "spending allowance" granted to the contract remains valid.
 * Security Impact: Leaves unnecessary elevated permissions on the contract if the user changes their mind or lowers the listing amount later.
 * Recommendation: Implement a clean-up mechanism in the catch block to reset the allowance to 0 if the subsequent transaction fails.
4. authenticatedFetch and "Silent Error" Loop
 * Discovery: authenticatedFetch only catches 401 (Unauthorized) errors to attempt a refresh.
 * Technical Risk: If the MongoDB backend is busy and returns 500/503, the fetchMyTrades polling mechanism silently swallows the error.
 * UX Risk: Polling stops without notifying the user. During a dispute, they miss the opponent's moves (e.g., pingTakerForChallenge) and lose track of the timer.
 * Recommendation: Implement an "Exponential Backoff" automatic retry logic for API errors.
5. SIWE Nonce "Eviction" Attack
 * Discovery: loginWithSIWE initiates the process by fetching a nonce from the backend, stored in Redis for 5 minutes.
 * Technical Risk: An unauthenticated attacker can spam /api/auth/nonce?wallet=address with thousands of requests using just a known wallet address.
 * Impact: This floods Redis. When memory limits are hit, legitimate users' valid nonces are purged via eviction policies, resulting in a Denial of Service (DoS) for platform logins.
6. "Zombie" Polling and Logout Race Condition
 * Discovery: Calling disconnect() sets setIsAuthenticated(false). However, it does not atomically kill the background fetchMyTrades polling loop (15s) currently in flight.
 * Technical Risk: An old fetch request may resolve milliseconds after logout.
 * Impact: The UI briefly repopulates with the logged-out user's trade data (zombie data). This is a privacy breach on shared devices.
7. UI "Role Spoofing" Risk
 * Discovery: The user's role (maker/taker) in activeEscrows.map is determined locally against the maker_address from the backend.
 * Technical Risk: A user can easily manipulate the local userRole state using React Developer Tools.
 * Impact: A Taker can spoof their role to "Maker" locally and reveal the "Release" button. While the contract will revert any attempts to use it, this can be weaponized for deceptive screenshots/blackmail.
8. Mainnet "Faucet UI" Leak
 * Discovery: handleMint (Get Test USDT/USDC) buttons are permanently rendered inside renderMarket.
 * Technical Risk: If deployed to Base Mainnet without strict process.env.NODE_ENV === 'development' or chainId === 84532 guards, these buttons will appear to real users.
 * Impact: Users risk clicking "Get Test USDT" while trading with real money, destroying professionalism and inciting "scam" suspicions.
9. "Ghost Listing" Leak (DB-First Pre-creation Risk)
 * Discovery: handleCreateEscrow posts to /api/listings before initiating the on-chain transaction.
 * Technical Risk: If the API call succeeds but the user rejects the MetaMask prompt or the transaction fails, the listing remains OPEN in MongoDB.
 * Impact: The marketplace fills with ghost listings that throw errors when clicked.
 * Recommendation: Save the listing as a Draft (PENDING) in the DB; only promote to OPEN when the backend captures the on-chain EscrowCreated event.
### PART 5: PII, COMPONENT RENDER, AND LOGGING VULNERABILITIES
1. usePII and Refresh Token Desync (Critical)
 * Discovery: App.jsx uses an advanced authenticatedFetch that catches 401s and silently refreshes. However, usePII.js uses standard fetch.
 * Technical Risk: If a user's JWT expires while in the trade room and they click "Show IBAN", the system throws a direct "PII Access Denied" error without attempting a refresh.
 * Impact: Legitimate users are denied access to IBANs due to technical desync, triggering unjustified disputes.
 * Recommendation: Route usePII.js calls through the centralized authenticatedFetch logic.
2. PII Leak Risk via ErrorBoundary (Sensitive Data)
 * Discovery: ErrorBoundary.jsx sends the error message and componentStack to the backend log system upon render failure.
 * Technical Risk: If an error occurs while an IBAN or Name is being rendered (e.g., inside PIIDisplay), the decrypted PII data is captured in the stack trace.
 * Impact: Despite the "Data is never stored plaintext" philosophy, highly sensitive data leaks into centralized backend logs as plain text.
 * Recommendation: Filter PII-containing component stacks before logging, or implement local, non-reporting error boundaries for sensitive components.
3. usePII Request Race Condition
 * Discovery: fetchPII is asynchronous but lacks an AbortController to cancel previous requests.
 * Technical Risk: If a user spam-clicks the button, multiple request-token calls hit the backend.
 * Impact: A slower, older response can overwrite the state of a newer request, and it needlessly burns through backend Rate Limits.
4. useCountdown Initial State Flicker
 * Discovery: isFinished state initializes as true by default in useCountdown.js.
 * UX Risk: Even if the target date is valid, the UI flashes "Time Expired" or "00:00" until the first second ticks over.
 * Impact: Action buttons attached to this state lock and unlock rapidly on every page reload, severely degrading user experience.
5. PIIDisplay Clipboard Security Gap
 * Discovery: handleCopyIban uses navigator.clipboard.writeText but does not handle failure cases (permission denied, browser restrictions).
 * Technical Risk: navigator.clipboard requires a Secure Context (HTTPS). On local/unsecured setups, it fails silently.
 * Impact: User believes they copied the IBAN but pastes old/empty clipboard data into their bank app, causing misdirected funds.
 * Recommendation: Wrap in a try-catch, verify window.isSecureContext, and provide a visual failure fallback.
6. MockERC20.sol: Lack of Access Control in "Admin Mint"
 * Discovery: mint(address to, uint256 amount) lacks any onlyOwner or access control modifiers.
 * Technical Risk: If this test file is accidentally deployed to a production network, any user can mint infinite tokens and destroy the protocol's economic balance instantly.
7. main.jsx: ErrorBoundary Paralyzing Provider Layers
 * Discovery: ErrorBoundary wraps the entire app, including WagmiProvider and QueryClientProvider.
 * Technical Risk: If a wallet connector plugin throws a background render error, the ErrorBoundary tears down the entire application.
 * Impact (Total Blackout): The user is completely locked out of the "Trade Room" where their funds are held just because of a minor plugin glitch.
 * Recommendation: Move ErrorBoundary inside the providers, right outside App.jsx.
8. ErrorBoundary.jsx: Local Port (Fallback) Leak in Production
 * Discovery: If VITE_API_URL is undefined, it attempts to POST logs to http://localhost:4000/api/logs/client-error.
 * Technical Risk: In production, if the env variable fails to load, the system attempts to leak sensitive error stacks to the user's local port 4000.
9. MockERC20.sol: Mapping Bloat and Lack of Cleanup
 * Discovery: lastMintTime mapping allocates permanent on-chain storage for every new wallet that hits the faucet.
 * Technical Risk: Bot spam during testnet phases will permanently bloat the contract's storage cost and state size. Requires an epoch-based or lighter rate-limiting approach.
### PART 6: SERVER (BACKEND), INFRASTRUCTURE, AND LOGGING VULNERABILITIES
1. Log Directory Traversal Risk
 * Discovery: Log file path in logger.js is set to the project root (../../araf_full_stack.log.txt).
 * Technical Risk: If the web server (Nginx/Apache) is misconfigured to serve static files from the root, the log file is exposed directly to the internet.
 * Impact: Stack traces, wallet addresses, and transaction IDs become a goldmine for attackers. Log files must reside in restricted system directories (e.g., /var/log).
2. Cancun EVM Version and L2 Compatibility Deadlock
 * Discovery: hardhat.config.js sets evmVersion: "cancun".
 * Technical Risk: Layer 2 networks like Base may not immediately support all Ethereum Mainnet Cancun updates (e.g., TLOAD/TSTORE opcodes).
 * Impact: Deploying libraries relying on these opcodes to Base can result in unrecognized opcode reverts, bricking the contract.
3. Error Logging Endpoint and "Disk Spam" Attack
 * Discovery: writeContract wrapper sends errors to the backend /api/logs/client-error endpoint.
 * Technical Risk: This endpoint operates auth-free.
 * Impact: Attackers can blast massive JSON payloads to this endpoint thousands of times a second, exhausting server disk space via logger.js in minutes (Disk Space Exhaustion).
4. EIP-712 Deadline and "Infinite Approval" Gap
 * Discovery: Frontend restricts cancellation deadlines to a maximum of 7 days.
 * Logic Flaw: If ArafEscrow.sol does not enforce this upper bound internally (e.g., require(deadline <= block.timestamp + 7 days)), the restriction is UI-only.
 * Risk: An attacker can generate a malicious cancellation signature valid for 10 years and hold it as a "zombie signature" to manipulate the honest party indefinitely.
5. Distributed Worker Race Condition
 * Discovery: eventListener.js tracks block numbers via CHECKPOINT_KEY in Redis.
 * Technical Risk: If the backend scales (multiple K8s pods or PM2 instances), multiple workers can scan the exact same blocks simultaneously.
 * Impact: Results in duplicate "Failure Scores" written to MongoDB or skipped events. A Redis-based Redlock (Distributed Lock) is mandatory.
6. Chain Re-org Sensitivity
 * Discovery: eventListener.js immediately updates MongoDB states upon catching an event.
 * Technical Risk: Layer 2 networks occasionally experience block "reverts" (Chain Re-orgs).
 * Impact: If a transaction drops off-chain post-reorg, MongoDB still says "Paid" or "Locked". The user thinks their funds are safe while the transaction never happened.
 * Recommendation: Wait for a specific "Block Confirmation" count (e.g., 5-10 blocks) or implement rollback logic upon detecting a reorg.
7. Reputation Cache Blind Spot (Tier Ceiling Risk)
 * Discovery: _onReputationUpdated updates successful, failed, bannedUntil, and effectiveTier, but ignores consecutiveBans and maxAllowedTier.
 * Logic Flaw: These fields are not emitted in the event.
 * Risk: Even if a user receives a severe on-chain ban dropping their ceiling to Tier 1, MongoDB (and the UI) will falsely display them as Tier 4. The contract will revert their listing attempts, causing confusion.
 * Recommendation: Read missing fields directly from the contract via multicall when the event triggers.
8. Event Replay and $inc Collision (Duplicate Scoring)
 * Discovery: _replayMissedEvents processes missed blocks in bulk.
 * Technical Risk: If the server crashes mid-process while applying an $inc (increment) operator for reputation points, and the Redis checkpoint hasn't updated, the rebooted server will process the event again.
 * Impact: Users receive duplicate failure or success scores, mathematically corrupting the reputation system. Enforce idempotency via transactionHash uniqueness in MongoDB.
9. Protocol Config and "Zombie" Cache (Migration Risk)
 * Discovery: protocolConfig.js caches on-chain parameters in Redis for 7 days (CONFIG_CACHE_TTL).
 * Logic Flaw: If the contract is upgraded (e.g., Burn duration reduced from 10 to 7 days), the backend ignores the blockchain and uses old rules for a week.
 * Impact: UI timers will be wrong, and contract transactions will fail with "Invalid Transaction" errors due to parameter mismatch.
10. DLQ (Dead Letter Queue) Choking Risk
 * Discovery: dlqProcessor.js processes 10 entries per minute.
 * Technical Risk: A 1-hour RPC outage dropping thousands of events into the DLQ will take days to clear at this rate.
 * Impact: Redis memory swells, and actual critical fixes are delayed.
11. Backend Data Type Precision Loss (BigInt -> Number)
 * Discovery: _onEscrowCreated saves on-chain amount values to MongoDB as Number(amount).
 * Technical Risk: JS Number (64-bit float) loses precision beyond 2^53 - 1.
 * Impact: When Phase 3 introduces 18-decimal tokens (e.g., cbBTC), amounts will easily breach this limit, severely corrupting financial data in the DB. Use Decimal128 or String in MongoDB.
12. Ping Classification and Race Condition
 * Discovery: _onMakerPinged categorizes pings based on matching the sender to trade.taker_address.
 * Logic Flaw: If EscrowLocked and MakerPinged occur milliseconds apart, the backend might process the ping before the lock event populates the taker_address in the DB.
 * Risk: The ping is misclassified or fails silently, breaking the autoRelease workflow.
13. Non-Atomic Database Updates
 * Discovery: _onEscrowReleased updates the Trade document, then makes a separate call to update User reputation points.
 * Technical Risk: A server crash exactly between these two calls marks the trade as RESOLVED but fails to award the user their reputation point.
 * Impact: Permanent database inconsistency. MongoDB Transactions (Sessions) are mandatory.
14. Fixed Protocol Fee Illusion (Fee Drift)
 * Discovery: App.jsx hardcodes the fee calculation: rawCryptoAmt * 0.001 (0.1%).
 * Logic Flaw: Architecture dictates fees are set on-chain.
 * Risk: If the contract fee is updated to 0.2%, the UI displays the old fee while the contract deducts the new fee, destroying financial transparency.
### PART 7: [CRITICAL & HIGH-SEVERITY] FATAL FINDINGS
1. [CRITICAL] Auth: Refresh Token Hijacking (Account Takeover)
 * Discovery: The /refresh endpoint (in auth.js) extracts the target wallet address from the request body/expired JWT and passes it with the cookie's refreshToken to rotateRefreshToken.
 * Fatal Flaw: rotateRefreshToken (in siwe.js) pulls the familyId from Redis but FAILS TO VERIFY if that token actually belongs to the requested wallet address.
 * Attack Scenario: An attacker uses their own valid refresh token but injects the Victim's wallet address in the payload. Redis validates the token and blindly issues a brand new JWT authorized as the Victim.
 * Impact: 100% reliable Account Takeover (ATO) requiring zero wallet signatures.
2. [CRITICAL] Game Theory Violation: Punishing the Victim (Algorithmic Betrayal)
 * Discovery: In eventListener.js (_onEscrowReleased), the logic checks if (wasDisputed && trade.maker_address) and applies the failure_score penalty.
 * Logic Flaw: If a CHALLENGED trade ends in RELEASED, it proves the Maker honestly sent the fiat and the Taker lied by opening a dispute. The code incorrectly penalizes the honest Maker instead of the malicious Taker!
 * Impact: The system algorithmically punishes its best sellers, directly violating its "make dishonesty expensive" protocol thesis.
3. [CRITICAL] UX / Performance: Render Thrashing (React Death Loop)
 * Discovery: App.jsx initializes countdowns via: const gracePeriodEndDate = activeTrade?.paidAt ? new Date(...) : null;
 * Lifecycle Flaw: new Date() creates a fresh object reference on every single React render. useCountdown's useEffect sees this new dependency, kills the setInterval, and restarts it every frame.
 * Impact: Six different timers trigger infinite tear-down/re-build cycles, completely freezing the browser and draining mobile batteries (UI Freeze). MUST be wrapped in useMemo.
4. [SECURITY] Triangulation Fraud "Bypass" Vulnerability
 * Discovery: The primary defense against Triangulation fraud is displaying the Taker's bankOwner name to the Maker. However, handleStartTrade does not verify if the Taker actually populated their PII data.
 * Vulnerability: A malicious Taker enters the system with a blank profile and locks the trade. The Maker sees null or "Loading..." for the name and cannot verify the incoming fiat sender.
 * Impact: The fraudster completely bypasses the security mechanism with zero technical hacking required.
5. [HIGH] Infrastructure: Multi-Layered RAM Bloat (DoS Bomb)
 * Discovery: receipts.js uses multer.memoryStorage() for 5MB receipt uploads.
 * Technical Risk: A 5MB file sits in RAM as a Buffer, converts to Base64 (swelling to ~6.6MB), and undergoes AES-256 encryption. A single upload consumes ~30MB of Node.js Heap memory.
 * Impact: 20-30 concurrent uploads (or a minor botnet) will trigger an immediate "Out of Memory" (OOM) crash, taking down all active trades globally. Use diskStorage and Streams.
6. [FATAL LOGIC] dlqProcessor.js: DLQ "Infinite Loop" and Archive Error
 * Discovery: _addToDLQ pushes failed events to the right (rPush) of the Redis list (Index 0 is oldest, -1 is newest). When archiving, dlqProcessor.js slices with redis.lRange(DLQ_KEY, -overflow, -1).
 * Vulnerability: It slices the newest incoming errors, archives them, and then trims the list, leaving the actual stuck/old 100 errors trapped in the active DLQ forever.
 * Impact: New critical errors are instantly swallowed/archived without retry attempts, while old errors infinitely loop and waste CPU. Fix: Use lRange(DLQ_KEY, 0, overflow - 1).
7. [CRITICAL FINANCE/MATH] Locking Fiat Amount as Crypto
 * Discovery: Taker crypto bond calculation in App.jsx: const cryptoAmtRaw = BigInt(Math.round((parseFloat(order.max) || 0) * 1e6));
 * Vulnerability: order.max is the Fiat limit (e.g., 50,000 TRY). The code forgets to divide this by the exchange_rate and sends it directly to the contract as a Crypto value.
 * Impact: A user trying to buy 50,000 TRY worth of crypto is forced by the UI to lock 50,000 USDT. The contract reverts due to insufficient balance, or a "whale" accidentally locks their entire net worth.
8. [CRITICAL INFRASTRUCTURE] rateLimiter.js: Global Proxy Blocking (Total Outage)
 * Discovery: Global API rate limiters use keyGenerator: (req) => req.ip.
 * Vulnerability: If the Node.js app sits behind a Load Balancer (Cloudflare, AWS) without app.set('trust proxy', true), req.ip returns the proxy's IP for every user globally.
 * Impact: The limit is 10 requests/minute. The moment the protocol goes live, the combined traffic of all users will instantly trigger the rate limit, blocking 100% of global traffic permanently (Self-DoS).
9. [HIGH MEMORY LEAK] eventListener.js: WebSocket "Zombie" Reconnection
 * Discovery: Upon RPC disconnect, _reconnect() generates a brand new WebSocketProvider and attaches listeners.
 * Vulnerability: The old provider instance is never explicitly destroyed (oldProvider.destroy()).
 * Impact: Network fluctuations spawn dozens of zombie WebSocket connections that linger in RAM. They duplicate event triggers, corrupting the DB and causing OOM crashes.
10. [HIGH DATA CORRUPTION] eventListener.js: Lack of Idempotency During Replay
 * Discovery: Server crashes force _replayMissedEvents. While some functions have idempotency checks, _onBleedingDecayed directly runs $inc: { "financials.total_decayed": Number(decayedAmount) }.
 * Impact: If a block is scanned twice during a replay error, the "Decayed Funds" metric mathematically doubles, corrupting financial reporting permanently.
### PART 8: ADAPTATION, LEAKAGE, AND DoS VULNERABILITIES
1. [CRITICAL ADAPTATION] Web3 Mobile Wallet "SameSite=Strict" Trap
 * Discovery: JWT cookie generated with sameSite: "strict".
 * Vulnerability: In dApp mobile environments, users switch to apps like MetaMask to sign, then navigate back (cross-site). Modern browsers drop "Strict" cookies upon return.
 * Impact: The user is instantly logged out upon returning to the dApp. The Trade Room locks, destroying UX. Switch to sameSite: "lax".
2. [CRITICAL API LOCKUP] errorHandler.js: "Request Hanging" Gap
 * Discovery: globalErrorHandler catches ValidationError and JWT errors via if blocks.
 * Vulnerability: If a generic 500 error (e.g., TypeError, DB disconnect) bypasses these blocks, the function ends without calling res.status(500).send() or next(err).
 * Impact: The Node.js Express request hangs indefinitely until timeout. Users are trapped looking at an infinite loading spinner.
3. [HIGH INFO LEAK] Plaintext PII Log Leak
 * Discovery: Error logger includes: body: process.env.NODE_ENV !== "production" ? req.body : {}
 * Vulnerability: Even in testnets, PUT /api/auth/profile contains plaintext IBANs, Names, and Telegram handles.
 * Impact: This violates the "PII is never plaintext" protocol rule. Real banking data leaks directly into araf_full_stack.log.txt. req.body must be sanitized before logging.
4. [CRITICAL DoS] auth.js: Forgotten Rate Limit and Cryptographic Spam
 * Discovery: authLimiter is imported but forgotten in the router.put("/profile", requireAuth, ...) route definition.
 * Vulnerability: This endpoint triggers encryptPII (heavy HKDF + AES-256-GCM cryptography).
 * Impact: An attacker can spam this un-rate-limited endpoint, maxing out the single-threaded Node.js CPU, rendering the entire platform unresponsive (Asymmetric CPU DoS).
5. [HIGH TOCTOU RACE] receipts.js: Evidence Tampering (Overwriting)
 * Discovery: upload checks if the trade is LOCKED via Trade.findOne(), but updates it via Trade.findOneAndUpdate() lines later without enforcing the status.
 * Vulnerability: Between the check and the use (Time-of-Check to Time-of-Use), the Maker might elevate the trade to CHALLENGED.
 * Impact: The Taker can overwrite their receipt file even after a dispute has started, manipulating evidence against the arbiter. status: "LOCKED" must be added to the update query.
6. [HIGH PENALTY EVASION] Replay Blindness
 * Discovery: _onEscrowReleased calculates penalties using an in-memory flag: const wasDisputed = existingTrade?.status === "CHALLENGED".
 * Vulnerability: If the server updates the trade status to RESOLVED but crashes before writing the user penalty, a server reboot triggers a replay.
 * Impact: During replay, existingTrade returns RESOLVED, so wasDisputed evaluates to false. The malicious user escapes a severe reputation penalty due to non-atomic execution.
7. [HIGH PRIVACY VIOLATION] pii.js: 15-Minute Ghost Access Window
 * Discovery: The /taker-name/:onchainId endpoint decrypts PII based solely on the requirePIIToken middleware without double-checking the live trade status.
 * Vulnerability: A Taker can request the token, immediately cancel the trade on-chain (CANCELED), and still use the 15-minute token to read the Maker's decrypted IBAN/Name. Live status check (LOCKED/PAID) is mandatory at decryption time.
### PART 9: DATABASE (MONGODB), CACHE, AND FINAL COMPREHENSIVE FINDINGS
1. [CRITICAL LOGIC] User.js: "Ban Removal" Illusion
 * Discovery: checkBanExpiry determines if a ban expired and modifies object properties: this.is_banned = false; this.banned_until = null;.
 * Vulnerability: It alters the in-memory Mongoose object but NEVER calls await this.save().
 * Impact: The ban appears lifted in a transient API response, but the user remains permanently banned in the database. The autonomous forgiveness mechanism is completely broken.
2. [CRITICAL DATA CORRUPTION] eventListener.js: Hardcoded "USDT/TRY" Fallback Trap
 * Discovery: If an on-chain EscrowCreated event lacks an off-chain MongoDB listing counterpart, it creates a fallback: { crypto_amount: Number(amount), exchange_rate: 0, crypto_asset: "USDT", fiat_currency: "TRY" }.
 * Vulnerability: If network lag delays a USDC/EUR listing sync, the system permanently records the trade as USDT/TRY with a 0 exchange rate.
 * Impact: Complete destruction of financial data integrity; users enter trade rooms with wrong currencies and panic.
3. [HIGH GAME THEORY] trades.js: Sabotaging the Cancellation Process (Proposal Overwrite)
 * Discovery: /propose-cancel blindly assigns: trade.cancel_proposal.deadline = new Date(value.deadline * 1000);.
 * Vulnerability: After a Maker honestly proposes a cancellation with their EIP-712 signature, a malicious Taker can spam the endpoint with a different deadline.
 * Impact: Overwriting the shared deadline invalidates the Maker's cryptographic signature on-chain. The Taker drags the transaction into a permanent Limbo (Deadlock) where it can never be canceled.
4. [LEGAL / PRIVACY RISK] receipts.js & Trade.js: Right to be Forgotten Illusion (Ghost Data)
 * Discovery: Comments state encrypted receipts will be set to null by a cleanup job when receipt_delete_at is reached.
 * Vulnerability: MongoDB's native TTL index deletes entire documents, not specific fields. There is no background "cleanupReceipts" Cron Job in the codebase.
 * Impact: KYC and banking receipts bypass the "Data Minimization and Destruction" promise, persisting forever in violation of GDPR/KVKK.
5. [CRITICAL GAME THEORY] pii.js & auth.js: Dynamic PII Manipulation (TOCTOU Attack)
 * Discovery: /taker-name/:onchainId reads the Taker's live bankOwner data. The /profile update route doesn't check for active trades.
 * Attack Scenario: Taker locks a trade. Initiates fiat transfer from a stolen bank account. Just before Maker sees the transfer, Taker updates their bankOwner profile to match the stolen account's name.
 * Impact: Maker sees a name match and releases funds. The system's PII mechanism is weaponized to perfectly execute Triangulation fraud. PII snapshots are strictly required.
6. [CRITICAL AUTONOMY] reputationDecay.js: Null Timestamp Blindness
 * Discovery: The reputation cleanup job queries banned_until: { $lt: 180DaysAgo }.
 * Vulnerability: When bans expire, banned_until is set to null. MongoDB's $lt operator does not match null values.
 * Impact: Honest users who returned to trading after a ban will never be found by this job. The "clean slate after 180 days" feature is fundamentally broken.
7. [HIGH AUDIT RISK] logs.js: Unauthenticated Log Deletion (Cover-up) Attack
 * Discovery: POST /client-error lacks authentication and specific Rate Limits.
 * Security Risk: The Winston logger (logger.js) caps file sizes at maxsize: 25MB and maxFiles: 5 (125MB total).
 * Impact: After exploiting a critical vulnerability, an attacker can spam this endpoint to hit the 125MB rotation limit in seconds, permanently deleting all legitimate audit logs containing their traces.
8. [HIGH DB CRASH] eventListener.js: Unbounded Array Growth
 * Discovery: Penalties are pushed to the reputation_history array in the User document using $push.
 * Technical Risk: No $slice limit is defined.
 * Impact: Active accounts will accumulate thousands of objects until hitting MongoDB's strict 16MB document limit. The database will permanently block updates for that user, freezing their account.
9. [CRITICAL BOTTLENECK] db.js: Connection Pool Starvation
 * Discovery: maxPoolSize is set to 10.
 * Vulnerability: Upon server reboot, eventListener.js executes heavy parallel DB queries to replay missed blocks.
 * Impact: The worker consumes all 10 connections. With serverSelectionTimeoutMS: 5000, normal API requests (login, market view) instantly crash with 500 MongoTimeoutErrors. Pool size must be increased (e.g., 50-100).
10. [HIGH INCOMPATIBILITY] db.js: Socket and Proxy Timeout Mismatch
 * Discovery: socketTimeoutMS is set to 45,000 (45 seconds).
 * Vulnerability: Reverse proxies (Cloudflare, Nginx) typically cut connections after 30 seconds, returning 504 Gateway Timeout.
 * Impact: Slow MongoDB queries continue to consume CPU/RAM for 45 seconds even though the user's connection was already dropped at 30 seconds (Zombie Queries).
11. [CRITICAL LOGIC] eventListener.js: Resurrection of Zombie Listings
 * Discovery: Off-chain matching queries: Listing.findOne({ maker_address: maker, onchain_escrow_id: null }).sort({ _id: -1 }).
 * Vulnerability: Forgets to filter by status: "OPEN".
 * Impact: If a Taker initiates an on-chain transaction right after a Maker deletes a listing, the backend finds the DELETED listing and resurrects it with $set: { status: "OPEN" }. Marketplace data is irreversibly corrupted.
12. [CRITICAL DATA LOSS] eventListener.js: "Blind Spot" Checkpoint Poisoning
 * Discovery: In _replayMissedEvents, the catch (err) block logs a warning and proceeds. At the end of the loop, _updateCheckpointIfHigher(to) is called regardless of failure.
 * Impact: If an RPC rate-limit occurs, events are not fetched. The system still advances the checkpoint, claiming the block was processed. Transactions are permanently lost without even entering the DLQ.
13. [MEDIUM UX/DATA] listings.js & trades.js: Unstable Pagination
 * Discovery: Listings are queried via .sort({ exchange_rate: 1 }).skip(skip).limit(value.limit).
 * Vulnerability: MongoDB does not guarantee order for documents with identical sorted values (e.g., 10 listings with the same exchange rate).
 * Impact: When users paginate from Page 1 to Page 2, identical listings might shuffle. Users will see duplicates and miss other listings entirely. A unique field (_id: 1) MUST be added to the sort criteria.
(Note: Provide this exact text in your repository. It requires immediate architectural reviews, especially concerning the Auth, Game Theory, and Render Thrashing categories).
