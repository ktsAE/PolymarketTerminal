// This module is loaded only for explicit account connection, never for DRY.
import { createSecureClient } from '@polymarket/client';
import { privateKey as privateKeySigner } from '@polymarket/client/viem';
export async function createAccountClient({ privateKey, walletAddress }) {
  if (process.env.PM_TERMINAL_ENABLE_REVIEWED_LIVE !== '1') throw Error('LIVE disabled pending release review');
  return createSecureClient({
    signer: privateKeySigner(privateKey),
    ...(walletAddress ? { wallet: walletAddress } : {}),
  });
}
export { buildOrderRequest } from './order-policy.cjs';
