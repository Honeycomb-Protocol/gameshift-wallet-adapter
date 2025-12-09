import type { SendTransactionOptions, WalletName } from '@solana/wallet-adapter-base';
import {
    BaseMessageSignerWalletAdapter,
    WalletConnectionError,
    WalletNotConnectedError,
    WalletPublicKeyError,
    WalletReadyState,
    WalletSignMessageError,
    WalletSignTransactionError,
    WalletSendTransactionError,
} from '@solana/wallet-adapter-base';
import type { Connection, Transaction, TransactionSignature, TransactionVersion, VersionedTransaction } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';

export interface GameshiftWalletAdapterConfig {
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

export class GameshiftWalletAdapter extends BaseMessageSignerWalletAdapter {
    name = GameshiftWalletName;
    url = 'https://gameshift.build';
    icon =
        'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTA4IiBoZWlnaHQ9IjEwOCIgdmlld0JveD0iMCAwIDEwOCAxMDgiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIxMDgiIGhlaWdodD0iMTA4IiByeD0iMjYiIGZpbGw9IiM2QjQ2QzEiLz4KPHBhdGggZD0iTTMwIDU0QzMwIDQwLjc0NTIgNDAuNzQ1MiAzMCA1NCAzMEM2Ny4yNTQ4IDMwIDc4IDQwLjc0NTIgNzggNTRDNzggNjcuMjU0OCA2Ny4yNTQ4IDc4IDU0IDc4QzQwLjc0NTIgNzggMzAgNjcuMjU0OCAzMCA1NFoiIHN0cm9rZT0id2hpdGUiIHN0cm9rZS13aWR0aD0iNiIvPgo8cGF0aCBkPSJNNTQgNDJWNjZNNDIgNTRINjYiIHN0cm9rZT0id2hpdGUiIHN0cm9rZS13aWR0aD0iNiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+Cjwvc3ZnPg==';
    supportedTransactionVersions: ReadonlySet<TransactionVersion> = new Set(['legacy', 0]);

    private _connecting: boolean;
    private _publicKey: PublicKey | null;
    private _token: string | null;
    private _portalUrl: string;
    private _popupWidth: number;
    private _popupHeight: number;
    private _popup: Window | null;
    private _messageHandler: ((event: MessageEvent) => void) | null;
    private _popupCheckInterval: ReturnType<typeof setInterval> | null;
    private _readyState: WalletReadyState =
        typeof window === 'undefined' || typeof document === 'undefined'
            ? WalletReadyState.Unsupported
            : WalletReadyState.Loadable;

    constructor(config: GameshiftWalletAdapterConfig = {}) {
        super();
        this._connecting = false;
        this._publicKey = null;
        this._token = null;
        this._portalUrl = config.portalUrl || 'http://localhost:3000';
        this._popupWidth = config.popupWidth || 450;
        this._popupHeight = config.popupHeight || 650;
        this._popup = null;
        this._messageHandler = null;
        this._popupCheckInterval = null;
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
                    if (event.origin !== this._portalUrl) return;

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

            // TODO: Implement actual transaction sending via GameShift portal
            throw new WalletSendTransactionError('sendTransaction is not yet implemented for GameShift wallet');
        } catch (error: any) {
            this.emit('error', error);
            throw error;
        }
    }

    async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
        try {
            if (!this._publicKey) throw new WalletNotConnectedError();

            // TODO: Implement actual transaction signing via GameShift portal popup
            throw new WalletSignTransactionError('signTransaction is not yet implemented for GameShift wallet');
        } catch (error: any) {
            this.emit('error', error);
            throw error;
        }
    }

    async signAllTransactions<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]> {
        try {
            if (!this._publicKey) throw new WalletNotConnectedError();

            // TODO: Implement actual batch transaction signing via GameShift portal popup
            throw new WalletSignTransactionError('signAllTransactions is not yet implemented for GameShift wallet');
        } catch (error: any) {
            this.emit('error', error);
            throw error;
        }
    }

    async signMessage(message: Uint8Array): Promise<Uint8Array> {
        try {
            if (!this._publicKey) throw new WalletNotConnectedError();

            // TODO: Implement actual message signing via GameShift portal popup
            throw new WalletSignMessageError('signMessage is not yet implemented for GameShift wallet');
        } catch (error: any) {
            this.emit('error', error);
            throw error;
        }
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
