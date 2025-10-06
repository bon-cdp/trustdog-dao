🐶 TrustDog DAO

Open escrow & verification protocol for creators — powered by Solana.
Contact handler@trustdog.co to work on the actual repo. 
🚀 Overview

TrustDog DAO builds transparent, on-chain escrow for creator and advertiser deals.
Funds are held in Solana escrow, released only after verified delivery by human + AI reviewers.
The DAO governs the rules, rewards verifiers, and maintains the open-source protocol.

🧩 Architecture

Frontend: Cloudflare Pages (SPA React + Tailwind)

API Worker: Cloudflare Worker (Hono) — handles deal creation, escrow, verification

Database: Supabase (Postgres + RLS + Storage)

Orchestrator: Node service — AI verification + HITL review queue

Solana Layer: Smart contracts for escrow init / refund / payout

DAO Layer: SPL Governance (Realms) manages treasury & contributor rewards

🪙 Mission

Create a community-owned trust layer for digital work.
Start with creator ads → expand to any verified digital service.

🎯 Current Milestones

✅ Solana escrow integration (MVP)

✅ End-to-end deal flow live on trustdog.co

🚧 DAO charter + governance launch

🚧 Reviewer reward system (via DAO treasury)

🧠 Future: AI-assisted proof verification for all deal types

🤝 Get Involved

Star this repo ⭐️

Join the community (Discord / Realms link TBA)

Contribute PRs → earn DAO rep tokens (DOGREP)

Help verify real creator deals and get rewarded

📜 License

MIT License — build, fork, and deploy freely.
Security-sensitive components (Orchestrator AI models) may remain proprietary for abuse prevention.

🐾

~$25 k escrowed on Solana

“Build trust into every transaction.” — TrustDog DAO
