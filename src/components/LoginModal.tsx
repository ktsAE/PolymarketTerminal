import { useState } from "react";

interface LoginModalProps {
  onClose(): void;
  onConnect(request: { privateKey: string; walletAddress?: string }): Promise<void>;
}

export function LoginModal({ onClose, onConnect }: LoginModalProps) {
  const [privateKey, setPrivateKey] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      await onConnect({ privateKey: privateKey.trim(), walletAddress: walletAddress.trim() || undefined });
      setPrivateKey("");
      setWalletAddress("");
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : "Could not connect account");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="login-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span>POLYMARKET ACCOUNT</span>
            <strong>Connect a signer</strong>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>×</button>
        </header>

        <div className="security-callout">
          Use a dedicated low-balance wallet. The key stays in app memory for this session and is never saved.
        </div>

        <label className="field-label">
          PRIVATE KEY
          <input
            autoFocus
            autoComplete="off"
            spellCheck={false}
            type="password"
            placeholder="0x…"
            value={privateKey}
            onChange={(event) => setPrivateKey(event.target.value)}
          />
        </label>

        <label className="field-label">
          EXISTING POLYMARKET WALLET <span>OPTIONAL</span>
          <input
            autoComplete="off"
            spellCheck={false}
            placeholder="0x… leave blank for Deposit Wallet"
            value={walletAddress}
            onChange={(event) => setWalletAddress(event.target.value)}
          />
        </label>

        <p className="field-help">
          If the signer owns an existing Proxy, Safe or Deposit Wallet, enter that account wallet here. Leaving it blank uses the signer's default Deposit Wallet.
        </p>
        {error && <div className="form-error">{error}</div>}
        <button className="primary-button" disabled={pending || privateKey.trim().length < 66}>
          {pending ? "CONNECTING…" : "CONNECT FOR THIS SESSION"}
        </button>
      </form>
    </div>
  );
}
