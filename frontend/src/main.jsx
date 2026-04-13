import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

import { WagmiProvider, createConfig, http } from 'wagmi'
import { base, baseSepolia, hardhat } from 'wagmi/chains'
import { coinbaseWallet, injected } from 'wagmi/connectors'
import { farcasterFrame } from '@farcaster/frame-wagmi-connector'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import ErrorBoundary from './components/ErrorBoundary.jsx'

const getCodespacesRPC = (port) => {
  try {
    const host = window.location.hostname
    if (host === 'localhost' || host === '127.0.0.1') return `http://127.0.0.1:${port}`
    return `https://${host.replace('-5173', `-${port}`)}`
  } catch {
    return `http://127.0.0.1:${port}`
  }
}

const CHAIN_MAP = {
  8453: base,
  84532: baseSepolia,
  31337: hardhat,
}

const allowedProdChainId = Number(import.meta.env.VITE_ALLOWED_CHAIN_ID || 84532)
const prodChain = CHAIN_MAP[allowedProdChainId] || baseSepolia
const activeChains = import.meta.env.PROD
  ? [prodChain]
  : [hardhat, baseSepolia, base]

const transports = {}
for (const chain of activeChains) {
  if (chain.id === hardhat.id) {
    transports[chain.id] = http(getCodespacesRPC(8545))
  } else {
    transports[chain.id] = http()
  }
}

const config = createConfig({
  chains: activeChains,
  connectors: [
    farcasterFrame(),
    injected(),
    coinbaseWallet({ appName: 'Araf Protocol' }),
  ],
  transports,
})

const queryClient = new QueryClient()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
)
