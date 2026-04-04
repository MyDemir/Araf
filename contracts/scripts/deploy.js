/**
 * ArafEscrow Deploy Script (Güncellenmiş Testnet + Mainnet Güvenli Sürüm)
 *
 * Deploy sonrası token support doğrulaması zincir üstünde teyit edilir.
 * Ownership, yalnızca tüm desteklenen tokenlar başarıyla aktif ve doğrulanmışsa devredilir.
 * Production ortamında gerçek token adresleri ENV'den zorunlu alınır; eksikse script hard fail olur.
 *
 * Kullanım: npx hardhat run scripts/deploy.js --network localhost
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function requireEnvAddress(name) {
  const value = process.env[name];
  if (!value || value === ZERO_ADDRESS) {
    throw new Error(`❌ ${name} .env'de zorunlu ve geçerli bir adres olmalı.`);
  }
  return ethers.getAddress(value);
}

function resolveProductionTokenConfig() {
  const isProduction = process.env.NODE_ENV === "production";

  if (!isProduction) {
    return {
      isProduction,
      usdtAddress: null,
      usdcAddress: null,
    };
  }

  return {
    isProduction,
    usdtAddress: requireEnvAddress("MAINNET_USDT_ADDRESS"),
    usdcAddress: requireEnvAddress("MAINNET_USDC_ADDRESS"),
  };
}

async function enableAndVerifySupportedToken(escrow, tokenAddress, symbol) {
  const setTx = await escrow.setSupportedToken(tokenAddress, true);
  await setTx.wait();

  const isSupported = await escrow.supportedTokens(tokenAddress);
  if (!isSupported) {
    throw new Error(`❌ ${symbol} desteklenen token olarak zincir üstünde doğrulanamadı: ${tokenAddress}`);
  }

  console.log(`✅ ${symbol} desteklenen token listesine eklendi ve zincir üstünde doğrulandı:`, tokenAddress);
  return { symbol, address: tokenAddress, isSupported };
}

async function main() {
  const { isProduction, usdtAddress: productionUsdt, usdcAddress: productionUsdc } =
    resolveProductionTokenConfig();

  const [deployer] = await ethers.getSigners();
  console.log("🚀 Deploy eden cüzdan:", deployer.address);
  console.log("🌍 Ortam:", isProduction ? "production" : "non-production");

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("💰 Bakiye:", ethers.formatEther(balance), "ETH\n");

  // ── Treasury & Owner ──────────────────────────────────────────────────────
  const treasuryAddress = requireEnvAddress("TREASURY_ADDRESS");
  console.log("🏦 Treasury & Son Owner adresi:", treasuryAddress);

  // ── 1. Escrow Kontratı Deploy ─────────────────────────────────────────────
  console.log("\n⏳ ArafEscrow deploy ediliyor...");
  const ArafEscrow = await ethers.getContractFactory("ArafEscrow");
  const escrow = await ArafEscrow.deploy(treasuryAddress);
  await escrow.waitForDeployment();

  const address = await escrow.getAddress();
  console.log("✅ ArafEscrow deploy edildi:", address);

  // ── ABI Kopyalama ─────────────────────────────────────────────────────────
  try {
    const artifactPath = path.resolve(__dirname, "../artifacts/src/ArafEscrow.sol/ArafEscrow.json");
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const abiDestDir = path.resolve(__dirname, "../../frontend/src/abi");
    const abiDestPath = path.join(abiDestDir, "ArafEscrow.json");

    fs.mkdirSync(abiDestDir, { recursive: true });
    fs.writeFileSync(abiDestPath, JSON.stringify(artifact.abi, null, 2));
    console.log("✅ ABI frontend'e kopyalandı.");
  } catch (err) {
    console.warn("⚠ ABI kopyalanamadı (Önemli Değil, Hardcoded ABI kullanıyoruz):", err.message);
  }

  // ── 2. Supported Token Kurulumu (Ownership devrinden ÖNCE) ───────────────
  let usdtAddress = productionUsdt || "";
  let usdcAddress = productionUsdc || "";
  const tokenSupportChecks = [];

  if (isProduction) {
    console.log("\n⏳ Production token adresleri merkezi config guard ile alındı...");
    console.log("✅ MAINNET_USDT_ADDRESS:", usdtAddress);
    console.log("✅ MAINNET_USDC_ADDRESS:", usdcAddress);
  } else {
    console.log("\n⏳ MockERC20 (USDT ve USDC) deploy ediliyor...");
    const MockERC20 = await ethers.getContractFactory("MockERC20");

    const usdt = await MockERC20.deploy("Mock USDT", "USDT", 6);
    await usdt.waitForDeployment();
    usdtAddress = await usdt.getAddress();
    console.log("✅ MockUSDT deploy edildi:", usdtAddress);

    const usdc = await MockERC20.deploy("Mock USDC", "USDC", 6);
    await usdc.waitForDeployment();
    usdcAddress = await usdc.getAddress();
    console.log("✅ MockUSDC deploy edildi:", usdcAddress);
  }

  tokenSupportChecks.push(await enableAndVerifySupportedToken(escrow, usdtAddress, "USDT"));
  tokenSupportChecks.push(await enableAndVerifySupportedToken(escrow, usdcAddress, "USDC"));

  const allTokenSupportVerified = tokenSupportChecks.every((check) => check.isSupported);
  if (!allTokenSupportVerified) {
    throw new Error("❌ Token support doğrulaması tamamlanmadı; ownership devri iptal edildi.");
  }

  // ── 3. Ownership Devri ────────────────────────────────────────────────────
  console.log("\n🔒 Ownership devrediliyor →", treasuryAddress);
  const tx = await escrow.transferOwnership(treasuryAddress);
  await tx.wait();
  console.log("✅ Ownership başarıyla devredildi!");

  // ── 4. FE .env Auto-write (Production'da KAPALI) ──────────────────────────
  if (!isProduction) {
    const frontendEnvPath = path.resolve(__dirname, "../../frontend/.env");
    const exampleEnvPath = path.resolve(__dirname, "../../frontend/.env.example");

    if (!fs.existsSync(frontendEnvPath) && fs.existsSync(exampleEnvPath)) {
      fs.copyFileSync(exampleEnvPath, frontendEnvPath);
      console.log("📝 .env.example'dan yeni .env oluşturuldu.");
    }

    if (fs.existsSync(frontendEnvPath)) {
      let envContent = fs.readFileSync(frontendEnvPath, "utf8");

      const codespaceName = process.env.CODESPACE_NAME;
      if (codespaceName) {
        const apiUrl = `https://${codespaceName}-4000.app.github.dev`;
        envContent = envContent.replace(/VITE_API_URL=.*/, `VITE_API_URL=${apiUrl}`);
      }

      envContent = envContent.replace(/VITE_ESCROW_ADDRESS=.*/, `VITE_ESCROW_ADDRESS=\"${address}\"`);
      envContent = envContent.replace(/VITE_USDT_ADDRESS=.*/, `VITE_USDT_ADDRESS=\"${usdtAddress}\"`);
      envContent = envContent.replace(/VITE_USDC_ADDRESS=.*/, `VITE_USDC_ADDRESS=\"${usdcAddress}\"`);

      fs.writeFileSync(frontendEnvPath, envContent);
      console.log("✅ .env dosyası otomatik olarak güncellendi (non-production). ");
    }
  } else {
    console.log("ℹ️ Production modunda frontend/.env auto-write atlandı.");
  }

  // ── 5. Sonuçlar ve completion koşulu ──────────────────────────────────────
  if (!allTokenSupportVerified) {
    throw new Error("❌ deployment complete koşulu sağlanmadı: token support doğrulaması başarısız.");
  }

  console.log("\n🎉 DEPLOYMENT COMPLETE (token support zincir üstünde doğrulandı) 🎉");
  console.log("--------------------------------------------------");
  console.log(`VITE_ESCROW_ADDRESS=\"${address}\"`);
  console.log(`VITE_USDT_ADDRESS=\"${usdtAddress}\"`);
  console.log(`VITE_USDC_ADDRESS=\"${usdcAddress}\"`);
  console.log("--------------------------------------------------");
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { resolveProductionTokenConfig };
