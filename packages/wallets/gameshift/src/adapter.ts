import type { SendTransactionOptions, WalletName } from '@solana/wallet-adapter-base';
import {
    BaseMessageSignerWalletAdapter,
    scopePollingDetectionStrategy,
    WalletConnectionError,
    WalletNotConnectedError,
    WalletPublicKeyError,
    WalletReadyState,
} from '@solana/wallet-adapter-base';
import type {
    Connection,
    Transaction,
    TransactionSignature,
    TransactionVersion,
    VersionedTransaction,
} from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import { MetaKeep } from 'metakeep';

export interface GameshiftWalletAdapterConfig {
    /** MetaKeep App ID for transaction signing (required) */
    metakeepAppId: string;
    /** The URL of the GameShift portal for wallet connection. Defaults to 'http://localhost:3000' */
    portalUrl?: string;
    /** Popup window width. Defaults to 450 */
    popupWidth?: number;
    /** Popup window height. Defaults to 650 */
    popupHeight?: number;
}

export const GameshiftWalletName = 'Gameshift' as WalletName<'Gameshift'>;

interface GameshiftAuthSuccessData {
    token: string;
    publicKey: string;
    state?: string;
}

interface GameshiftAuthMessage {
    type: 'gameshift:auth:success' | 'gameshift:auth:error' | 'gameshift:auth:closed';
    data?: GameshiftAuthSuccessData;
    error?: {
        code: string;
        message: string;
    };
}

interface GameshiftSignMessage {
    type: 'gameshift:sign:success' | 'gameshift:sign:error' | 'gameshift:sign:closed';
    data?: {
        signedTransaction: string; // hex encoded signed transaction
    };
    error?: {
        code: string;
        message: string;
    };
}

export class GameshiftWalletAdapter extends BaseMessageSignerWalletAdapter {
    name = GameshiftWalletName;
    url = 'https://gameshift.build';
    icon =
        'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTA4IiBoZWlnaHQ9IjEwOCIgdmlld0JveD0iMCAwIDEwOCAxMDgiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIxMDgiIGhlaWdodD0iMTA4IiByeD0iMjYiIGZpbGw9IiM2QjQ2QzEiLz4KPHBhdGggZD0iTTMwIDU0QzMwIDQwLjc0NTIgNDAuNzQ1MiAzMCA1NCAzMEM2Ny4yNTQ4IDMwIDc4IDQwLjc0NTIgNzggNTRDNzggNjcuMjU0OCA2Ny4yNTQ4IDc4IDU0IDc4QzQwLjc0NTIgNzggMzAgNjcuMjU0OCAzMCA1NFoiIHN0cm9rZT0id2hpdGUiIHN0cm9rZS13aWR0aD0iNiIvPgo8cGF0aCBkPSJNNTQgNDJWNjZNNDIgNTRINjYiIHN0cm9rZT0id2hpdGUiIHN0cm9rZS13aWR0aD0iNiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+Cjwvc3ZnPg==';
    supportedTransactionVersions: ReadonlySet<TransactionVersion> = new Set(['legacy', 0]);

    private _connecting: boolean;
    private _publicKey: PublicKey | null;
    private _token: string | null;
    private _email: string | null;
    private _portalUrl: string;
    private _metakeepAppId: string;
    private _popupWidth: number;
    private _popupHeight: number;
    private _popup: Window | null;
    private _messageHandler: ((event: MessageEvent) => void) | null;
    private _popupCheckInterval: ReturnType<typeof setInterval> | null;
    private _readyState: WalletReadyState = WalletReadyState.Loadable;

    constructor(config: GameshiftWalletAdapterConfig) {
        super();
        this._connecting = false;
        this._publicKey = null;
        this._token = null;
        this._email = null;
        // Normalize portal URL: remove trailing slash and ensure www prefix for consistency
        this._portalUrl = this._normalizePortalUrl(config.portalUrl || 'http://localhost:3000');
        this._metakeepAppId = config.metakeepAppId;
        this._popupWidth = config.popupWidth || 450;
        this._popupHeight = config.popupHeight || 650;
        this._popup = null;
        this._messageHandler = null;
        this._popupCheckInterval = null;

        scopePollingDetectionStrategy(() => {
            this._readyState = WalletReadyState.Installed;
            this.emit('readyStateChange', this._readyState);
            return true;
        });
    }

    get publicKey() {
        return this._publicKey;
    }

    get connecting() {
        return this._connecting;
    }

    get readyState() {
        return this._readyState;
    }

    /**
     * Get the authentication token received from the GameShift portal.
     * This can be used for server-side token exchange.
     */
    get token(): string | null {
        return this._token;
    }

    /**
     * Get the user's email address after connection.
     */
    get email(): string | null {
        return this._email;
    }

    async autoConnect(): Promise<void> {
        // Skip autoconnect in the Loadable state
        // We can't redirect to a universal link without user input
        if (this.readyState === WalletReadyState.Installed) {
            await this.connect();
        }
    }

    async connect(): Promise<void> {
        try {
            if (this.connected || this.connecting) return;

            if (this._readyState === WalletReadyState.Unsupported) {
                throw new WalletConnectionError('Wallet is not supported in this environment');
            }

            this._connecting = true;

            const connectionPromise = new Promise<{ publicKey: string; token: string }>((resolve, reject) => {
                const state = `gameshift-${Date.now()}`;
                let isResolved = false;

                // Calculate popup position (centered)
                const left = window.screenX + (window.outerWidth - this._popupWidth) / 2;
                const top = window.screenY + (window.outerHeight - this._popupHeight) / 2;

                // Build popup URL
                const origin = window.location.origin;
                const popupUrl = `${this._portalUrl}/auth/wallet-connect?origin=${encodeURIComponent(origin)}&state=${encodeURIComponent(state)}`;

                // Message handler for postMessage from popup
                this._messageHandler = (event: MessageEvent) => {
                    // Only accept messages from the portal
                    if (event.origin !== this._portalUrl) {
                        console.log('Origin mismatch, ignoring message');
                        return;
                    }

                    const message = event.data as GameshiftAuthMessage;
                    switch (message.type) {
                        case 'gameshift:auth:success':
                            if (message.data && !isResolved) {
                                isResolved = true;
                                this._cleanup();
                                resolve({
                                    publicKey: message.data.publicKey,
                                    token: message.data.token,
                                });
                            }
                            break;

                        case 'gameshift:auth:error':
                            if (!isResolved) {
                                isResolved = true;
                                this._cleanup();
                                reject(new WalletConnectionError(message.error?.message || 'Authentication failed'));
                            }
                            break;

                        case 'gameshift:auth:closed':
                            // Ignore - during OAuth flows the portal may send this incorrectly.
                            // The connection will remain in "connecting" state if user closes popup manually.
                            break;
                    }
                };

                window.addEventListener('message', this._messageHandler);

                // Open popup
                this._popup = window.open(
                    popupUrl,
                    'gameshift-wallet-connect',
                    `width=${this._popupWidth},height=${this._popupHeight},left=${left},top=${top},popup=1,scrollbars=yes`
                );

                if (!this._popup) {
                    this._cleanup();
                    reject(new WalletConnectionError('Failed to open popup - it may be blocked by the browser'));
                    return;
                }

                // Poll for popup being closed by user
                // Use a counter to allow OAuth redirects time to complete
                let closedCheckCount = 0;
                this._popupCheckInterval = setInterval(() => {
                    try {
                        if (this._popup?.closed) {
                            closedCheckCount++;
                            // Wait for 3 consecutive checks (1.5s) to confirm it's really closed
                            // This allows OAuth redirects time to complete
                            if (closedCheckCount >= 3 && !isResolved) {
                                debugger;
                                isResolved = true;
                                this._cleanup();
                                reject(new WalletConnectionError('User closed the authentication popup'));
                            }
                        } else {
                            closedCheckCount = 0;
                        }
                    } catch {
                        // Ignore errors accessing cross-origin popup
                    }
                }, 500);
            });

            const { publicKey, token } = await connectionPromise;

            let parsedPublicKey: PublicKey;
            try {
                parsedPublicKey = new PublicKey(publicKey);
            } catch (error: any) {
                throw new WalletPublicKeyError(error?.message, error);
            }

            this._publicKey = parsedPublicKey;
            this._token = token;

            // Exchange token for user info (email)
            try {
                const response = await fetch(`${this._portalUrl}/api/auth/wallet/exchange`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ token }),
                });

                if (response.ok) {
                    const data = await response.json();
                    this._email = data.user?.email || null;
                }
            } catch {
                // Silently fail - email is optional for connection
            }

            this.emit('connect', parsedPublicKey);
        } catch (error: any) {
            this.emit('error', error);
            throw error;
        } finally {
            this._connecting = false;
        }
    }

    async disconnect(): Promise<void> {
        this._cleanup();

        const wasConnected = this._publicKey !== null;

        this._publicKey = null;
        this._token = null;
        this._email = null;

        if (wasConnected) {
            this.emit('disconnect');
        }
    }

    async sendTransaction<T extends Transaction | VersionedTransaction>(
        transaction: T,
        connection: Connection,
        options: SendTransactionOptions = {}
    ): Promise<TransactionSignature> {
        try {
            if (!this._publicKey) throw new WalletNotConnectedError();
            transaction = await this.signTransaction(transaction);
            return connection.sendRawTransaction(transaction.serialize(), options);
        } catch (error: any) {
            this.emit('error', error);
            throw error;
        }
    }

    async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
        try {
            if (!this._publicKey) throw new WalletNotConnectedError();
            if (!this._email) throw new WalletNotConnectedError('User email not available');

            const sdk = new MetaKeep({
                appId: this._metakeepAppId,
                user: { email: this._email },
            });

            const signature = await sdk.signTransaction(transaction, 'Signing transaction using GameShift Wallet');
            transaction.addSignature(this._publicKey, Buffer.from(signature.signature.slice(2), 'hex'));

            return transaction;
        } catch (error: any) {
            this.emit('error', error);
            throw error;
        }
    }

    async signAllTransactions<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]> {
        try {
            if (!this._publicKey) throw new WalletNotConnectedError();
            if (!this._email) throw new WalletNotConnectedError('User email not available');

            const sdk = new MetaKeep({
                appId: this._metakeepAppId,
                user: { email: this._email },
            });

            const { signatures }: { status: 'SUCCESS'; signatures: { signature: string }[] } =
                await sdk.signTransactionMultiple(
                    transactions.map((t) => ({
                        transactionObject: t,
                        reason: 'Signing transaction using GameShift Wallet',
                    })),
                    'Signing multiple transactions using GameShift Wallet'
                );

            // Sign transactions one by one
            const signedTransactions: T[] = [];
            for (const transaction of transactions) {
                transaction.addSignature(
                    this._publicKey,
                    Buffer.from(signatures[signedTransactions.length].signature.slice(2), 'hex')
                );
                signedTransactions.push(transaction);
            }
            return signedTransactions;
        } catch (error: any) {
            this.emit('error', error);
            throw error;
        }
    }

    async signMessage(message: Uint8Array): Promise<Uint8Array> {
        try {
            if (!this._publicKey) throw new WalletNotConnectedError();
            if (!this._email) throw new WalletNotConnectedError('User email not available');

            const sdk = new MetaKeep({
                appId: this._metakeepAppId,
                user: { email: this._email },
            });

            const { signature }: { status: 'SUCCESS'; signature: string } = await sdk.signMessage(
                Buffer.from(message).toString(),
                'Signing message using GameShift Wallet'
            );

            return Buffer.from(signature.slice(2), 'hex');
        } catch (error: any) {
            this.emit('error', error);
            throw error;
        }
    }

    private _normalizePortalUrl(url: string): string {
        // Remove trailing slash
        url = url.replace(/\/$/, '');

        // For non-localhost URLs, ensure www prefix if the portal uses it
        try {
            const parsed = new URL(url);
            if (parsed.hostname !== 'localhost' && !parsed.hostname.startsWith('www.')) {
                // Add www prefix for production domains (e.g., gameshift.gg -> www.gameshift.gg)
                parsed.hostname = `www.${parsed.hostname}`;
                return parsed.toString().replace(/\/$/, '');
            }
        } catch {
            // If URL parsing fails, return as-is
        }

        return url;
    }

    private _cleanup(): void {
        if (this._messageHandler) {
            window.removeEventListener('message', this._messageHandler);
            this._messageHandler = null;
        }

        if (this._popupCheckInterval) {
            clearInterval(this._popupCheckInterval);
            this._popupCheckInterval = null;
        }

        if (this._popup) {
            try {
                if (!this._popup.closed) {
                    this._popup.close();
                }
            } catch {
                // Ignore errors when accessing cross-origin popup
            }
            this._popup = null;
        }
    }
}
