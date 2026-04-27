# Base Sepolia GitHub Actions Notu

Bu dosya, repo degisiklikleri sirasinda GitHub Actions akisini belgelemek icin eklendi.

Hedef ortam:

- Network: Base Sepolia
- Chain ID: 84532
- Fly app: araf-protocol-backend
- Backend URL: https://araf-protocol-backend.fly.dev

Workflow akisi:

1. contracts klasorunde dependency kurulumu yapilir.
2. Hardhat compile calisir.
3. Base Sepolia deploy calisir.
4. deploy.log icinden su degerler okunur:
   - VITE_ESCROW_ADDRESS
   - VITE_USDT_ADDRESS
   - VITE_USDC_ADDRESS
   - VITE_ALLOWED_CHAIN_ID
   - ARAF_DEPLOYMENT_BLOCK
5. Fly secrets guncellenir.
6. Backend Fly'a deploy edilir.
7. Frontend Vercel'e deploy edilir.

GitHub Secrets kullanici tarafindan repo ayarlarindan eklenecektir.
