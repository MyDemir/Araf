const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const NETWORK_CONFIG = {
  hardhat: {
    displayName: "Hardhat Local",
    expectedChainId: 31337,
    tokenStrategy: "mock",
    autoWriteFrontendEnv: true,
    frontendAllowedChainId: 31337,
  },
  localhost: {
    displayName: "Localhost",
    expectedChainId: 31337,
    tokenStrategy: "mock",
    autoWriteFrontendEnv: true,
    frontendAllowedChainId: 31337,
  },
  "base-sepolia": {
    displayName: "Base Sepolia",
    expectedChainId: 84532,
    tokenStrategy: "mock-usdt-official-usdc",
    usdcEnv: "BASE_SEPOLIA_USDC_ADDRESS",
    autoWriteFrontendEnv: true,
    frontendAllowedChainId: 84532,
  },
  base: {
    displayName: "Base Mainnet",
    expectedChainId: 8453,
    tokenStrategy: "env",
    usdtEnv: "MAINNET_USDT_ADDRESS",
    usdcEnv: "MAINNET_USDC_ADDRESS",
    autoWriteFrontendEnv: false,
    frontendAllowedChainId: 8453,
  },
};

function requireEnvAddress(name) {
  const value = process.env[name];
  if (!value || value === ZERO_ADDRESS) {
    throw new Error(`${name} .env'de zorunlu ve geçerli bir adres olmalı.`);
  }
  return ethers.getAddress(value);
}

function resolveDeploymentConfig(networkName) {
  const config = NETWORK_CONFIG[networkName];
  if (!config) {
    throw new Error(`Desteklenmeyen network: ${networkName}. Desteklenenler: ${Object.keys(NETWORK_CONFIG).join(", ")}`);
  }
  return { networkName, ...config };
}

async function assertExpectedNetwork(config) {
  const providerNetwork = await ethers.provider.getNetwork();
  const actualChainId = Number(providerNetwork.chainId);
  if (actualChainId !== config.expectedChainId) {
    throw new Error(`Network güvenlik kontrolü başarısız. Beklenen chainId=${config.expectedChainId}, provider=${actualChainId}.`);
  }
}

function upsertEnvLine(content, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) return content.replace(pattern, line);
  const needsTrailingNewline = content.length > 0 && !content.endsWith("\n");
  return `${content}${needsTrailingNewline ? "\n" : ""}${line}\n`;
}

async function deployMockToken(symbol) {
  console.log(`MockERC20 (${symbol}) deploy ediliyor...`);
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const token = await MockERC20.deploy(`Mock ${symbol}`, symbol, 6);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log(`Mock${symbol} deploy edildi:`, tokenAddress);
  return tokenAddress;
}

async function enableAndVerifySupportedToken(escrow, tokenAddress, symbol) {
  const setTx = await escrow.setSupportedToken(tokenAddress, true);
  await setTx.wait();
  const isSupported = await escrow.supportedTokens(tokenAddress);
  if (!isSupported) throw new Error(`${symbol} desteklenen token olarak doğrulanamadı: ${tokenAddress}`);
  console.log(`${symbol} supported token olarak doğrulandı:`, tokenAddress);
  return { symbol, address: tokenAddress, isSupported };
}

async function resolveTokenConfig(config) {
  if (config.tokenStrategy === "mock") {
    return {
      usdtAddress: await deployMockToken("USDT"),
      usdcAddress: await deployMockToken("USDC"),
    };
  }

  if (config.tokenStrategy === "mock-usdt-official-usdc") {
    const usdtAddress = await deployMockToken("USDT");
    const usdcAddress = requireEnvAddress(config.usdcEnv);
    console.log(`${config.displayName} resmi USDC adresi ENV'den alındı:`, usdcAddress);
    return { usdtAddress, usdcAddress };
  }

  const usdtAddress = requireEnvAddress(config.usdtEnv);
  const usdcAddress = requireEnvAddress(config.usdcEnv);
  console.log(`${config.displayName} token adresleri ENV'den alındı.`);
  return { usdtAddress, usdcAddress };
}

function syncFrontendEnv({ escrowAddress, usdtAddress, usdcAddress, allowedChainId }) {
  const frontendEnvPath = path.resolve(__dirname, "../../frontend/.env");
  const exampleEnvPath = path.resolve(__dirname, "../../frontend/.env.example");
  if (!fs.existsSync(frontendEnvPath) && fs.existsSync(exampleEnvPath)) {
    fs.copyFileSync(exampleEnvPath, frontendEnvPath);
    console.log("frontend/.env example dosyasından oluşturuldu.");
  }
  if (!fs.existsSync(frontendEnvPath)) {
    console.log("frontend/.env bulunamadı; auto-write atlandı.");
    return;
  }

  let envContent = fs.readFileSync(frontendEnvPath, "utf8");
  const codespaceName = process.env.CODESPACE_NAME;
  if (codespaceName) {
    envContent = upsertEnvLine(envContent, "VITE_API_URL", `https://${codespaceName}-4000.app.github.dev`);
  }
  envContent = upsertEnvLine(envContent, "VITE_ESCROW_ADDRESS", escrowAddress);
  envContent = upsertEnvLine(envContent, "VITE_USDT_ADDRESS", usdtAddress);
  envContent = upsertEnvLine(envContent, "VITE_USDC_ADDRESS", usdcAddress);
  envContent = upsertEnvLine(envContent, "VITE_ALLOWED_CHAIN_ID", String(allowedChainId));
  fs.writeFileSync(frontendEnvPath, envContent);
  console.log("frontend/.env deploy çıktısına göre güncellendi.");
}

async function getDeploymentBlock(contract) {
  const deployTx = contract.deploymentTransaction?.();
  if (!deployTx) return ethers.provider.getBlockNumber();
  const receipt = await deployTx.wait();
  return receipt?.blockNumber || ethers.provider.getBlockNumber();
}

async function main() {
  const config = resolveDeploymentConfig(hre.network.name);
  await assertExpectedNetwork(config);

  const [deployer] = await ethers.getSigners();
  console.log("Deploy eden cüzdan:", deployer.address);
  console.log("Network:", config.displayName, `(${config.networkName})`);
  console.log("Beklenen chainId:", config.expectedChainId);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Bakiye:", ethers.formatEther(balance), "ETH");

  const treasuryAddress = requireEnvAddress("TREASURY_ADDRESS");
  console.log("Treasury ve son owner:", treasuryAddress);

  console.log("ArafEscrow deploy ediliyor...");
  const ArafEscrow = await ethers.getContractFactory("ArafEscrow");
  const escrow = await ArafEscrow.deploy(treasuryAddress);
  await escrow.waitForDeployment();

  const address = await escrow.getAddress();
  const deploymentBlock = await getDeploymentBlock(escrow);
  console.log("ArafEscrow deploy edildi:", address);
  console.log("ArafEscrow deploy block:", deploymentBlock);

  try {
    const artifactPath = path.resolve(__dirname, "../artifacts/src/ArafEscrow.sol/ArafEscrow.json");
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const abiDestDir = path.resolve(__dirname, "../../frontend/src/abi");
    const abiDestPath = path.join(abiDestDir, "ArafEscrow.json");
    fs.mkdirSync(abiDestDir, { recursive: true });
    fs.writeFileSync(abiDestPath, JSON.stringify(artifact.abi, null, 2));
    console.log("ABI frontend'e kopyalandı.");
  } catch (err) {
    console.warn("ABI kopyalanamadı:", err.message);
  }

  const { usdtAddress, usdcAddress } = await resolveTokenConfig(config);
  const tokenSupportChecks = [];
  tokenSupportChecks.push(await enableAndVerifySupportedToken(escrow, usdtAddress, "USDT"));
  tokenSupportChecks.push(await enableAndVerifySupportedToken(escrow, usdcAddress, "USDC"));

  const allTokenSupportVerified = tokenSupportChecks.every((check) => check.isSupported);
  if (!allTokenSupportVerified) throw new Error("Token support doğrulaması tamamlanmadı; ownership devri iptal edildi.");

  console.log("Ownership devrediliyor:", treasuryAddress);
  const tx = await escrow.transferOwnership(treasuryAddress);
  await tx.wait();
  console.log("Ownership başarıyla devredildi.");

  if (config.autoWriteFrontendEnv) {
    syncFrontendEnv({ escrowAddress: address, usdtAddress, usdcAddress, allowedChainId: config.frontendAllowedChainId });
  } else {
    console.log(`${config.displayName} için frontend/.env auto-write atlandı.`);
  }

  console.log("DEPLOYMENT COMPLETE");
  console.log("--------------------------------------------------");
  console.log(`VITE_ESCROW_ADDRESS=${address}`);
  console.log(`VITE_USDT_ADDRESS=${usdtAddress}`);
  console.log(`VITE_USDC_ADDRESS=${usdcAddress}`);
  console.log(`VITE_ALLOWED_CHAIN_ID=${config.frontendAllowedChainId}`);
  console.log(`ARAF_DEPLOYMENT_BLOCK=${deploymentBlock}`);
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

module.exports = { resolveDeploymentConfig };
