import { IHttp, ILogger, IPersistence, IRead } from '@rocket.chat/apps-engine/definition/accessors';
import { RocketChatAssociationModel, RocketChatAssociationRecord } from '@rocket.chat/apps-engine/definition/metadata';
import { IOAuthCredentials, IOAuthService } from '../../definition/auth/IAuth';
import { OAuthStorage } from '../../storage/OAuthStorage';
import {
    GoogleOauthUrls,
    GoogleOauthScopes,
    OauthConfig,
    ContentTypes,
    HttpHeaders
} from '../../constants/AuthConstants';
import { Translations } from '../../constants/Translations';

export class GoogleOAuthService implements IOAuthService {
    private clientId: string = '';
    private clientSecret: string = '';
    private redirectUri: string = '';
    private initialized: boolean = false;
    private oauthStorage: OAuthStorage;

    constructor(
        private readonly http: IHttp,
        private readonly persistence: IPersistence,
        private readonly read: IRead,
        private readonly logger: ILogger,
        private readonly settings: any
    ) {
        this.oauthStorage = new OAuthStorage(persistence, read.getPersistenceReader());
    }

    /**
     * Initialize the service with settings
     */
    public async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        try {
            this.clientId = await this.settings.get('oauth_client_id');
            this.clientSecret = await this.settings.get('oauth_client_secret');
            this.redirectUri = await this.settings.get('oauth_redirect_uri');

            if (!this.clientId || !this.clientSecret || !this.redirectUri) {
                throw new Error(Translations.AUTH_MISSING_OAUTH_SETTINGS);
            }

            this.initialized = true;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(Translations.AUTH_INITIALIZATION_FAILED + ': ' + errorMessage);
        }
    }

    /**
     * Generate a random state string for OAuth security
     */
    public generateState(): string {
        return Math.random().toString(36).substring(2, 15) +
               Math.random().toString(36).substring(2, 15);
    }

    /**
     * Save the OAuth state for a user
     */
    public async saveState(state: string, userId: string): Promise<void> {
        await this.oauthStorage.saveState(state, userId);
    }

    /**
     * Validate OAuth state and return user info
     */
    public async validateState(state: string): Promise<{userId: string} | undefined> {
        try {
            const result = await this.oauthStorage.validateState(state);
            if (!result) {
                return undefined;
            }
            return result;
        } catch (error) {
            return undefined;
        }
    }

    public async getAuthorizationUrl(userId: string): Promise<string> {

        // Generate a state parameter for security
        const state = this.generateState();

        // Save the state for this user
        await this.saveState(state, userId);

        // Get the authorization URL with the state parameter
        const url = this.getAuthUrl(state);

        return url;
    }

    public getAuthUrl(state: string): string {
        const url = new URL(GoogleOauthUrls.AUTHORIZATION);
        url.searchParams.append('client_id', this.clientId);
        url.searchParams.append('redirect_uri', this.redirectUri);
        url.searchParams.append('response_type', OauthConfig.RESPONSE_TYPE);
        url.searchParams.append('access_type', OauthConfig.ACCESS_TYPE);
        url.searchParams.append('prompt', OauthConfig.PROMPT_CONSENT);
        url.searchParams.append('scope', GoogleOauthScopes.join(' '));
        url.searchParams.append('state', state);

        return url.toString();
    }

    public async exchangeCodeForTokens(code: string): Promise<IOAuthCredentials> {

        try {
            if (!this.initialized) {
                await this.initialize();
            }

            const response = await this.http.post(GoogleOauthUrls.TOKEN, {
                headers: {
                    [HttpHeaders.CONTENT_TYPE]: ContentTypes.APPLICATION_FORM_URLENCODED,
                },
                content: `code=${encodeURIComponent(code)}&client_id=${encodeURIComponent(this.clientId)}&client_secret=${encodeURIComponent(this.clientSecret)}&redirect_uri=${encodeURIComponent(this.redirectUri)}&grant_type=${OauthConfig.GRANT_TYPE_AUTHORIZATION_CODE}`,
            });

            if (response.statusCode !== 200) {
                const errorContent = response.content || Translations.COMMON_UNKNOWN_ERROR;
                throw new Error(`${Translations.COMMON_FAILED_EXCHANGE_CODE}: HTTP ${response.statusCode}`);
            }

            const data = JSON.parse(response.content || '{}');

            if (!data.access_token) {
                throw new Error(Translations.AUTH_NO_ACCESS_TOKEN);
            }

            // Get user info to get email
            const userInfo = await this.getUserInfoFromToken(data.access_token);

            if (!userInfo || !userInfo.email) {
                throw new Error(Translations.AUTH_NO_USER_EMAIL_GOOGLE);
            }

            return {
                access_token: data.access_token,
                refresh_token: data.refresh_token,
                token_type: data.token_type,
                expiry_date: Date.now() + (data.expires_in * 1000),
                scope: data.scope,
                email: userInfo.email
            };
        } catch (error) {
            throw new Error(`${Translations.AUTH_EXCHANGE_CODE_FAILED}: ${error.message}`);
        }
    }

    /**
     * Get user info from Google API using access token
     */
    private async getUserInfoFromToken(accessToken: string): Promise<any> {
        try {
            const response = await this.http.get(GoogleOauthUrls.USER_INFO, {
                headers: {
                    [HttpHeaders.AUTHORIZATION]: `${OauthConfig.AUTHORIZATION_HEADER_PREFIX} ${accessToken}`
                }
            });

            if (response.statusCode !== 200) {
                throw new Error(`${Translations.COMMON_FAILED_GET_USER_INFO}: HTTP ${response.statusCode}`);
            }

            return JSON.parse(response.content || '{}');
        } catch (error) {
            throw new Error(`${Translations.AUTH_GET_USER_INFO_FAILED}: ${error.message}`);
        }
    }

    /**
     * Get user info using stored credentials
     */
    public async getUserInfo(userId: string): Promise<any> {
        try {
            const accessToken = await this.getValidAccessToken(userId);
            const userInfo = await this.getUserInfoFromToken(accessToken);
            
            if (!userInfo || !userInfo.email) {
                throw new Error(Translations.COMMON_USER_INFO_INCOMPLETE);
            }
            
            return userInfo;
        } catch (error) {
            throw new Error(`${Translations.AUTH_GET_USER_INFO_FAILED}: ${error.message}`);
        }
    }

    /**
     * Save OAuth credentials for a user
     */
    public async saveCredentials(userId: string, credentials: IOAuthCredentials): Promise<void> {
        await this.oauthStorage.saveCredentials(userId, credentials);
    }

    /**
     * Get OAuth credentials for a user
     */
    public async getCredentials(userId: string): Promise<IOAuthCredentials | undefined> {
        try {
            const credentials = await this.oauthStorage.getCredentials(userId);
            return credentials;
        } catch (error) {
            return undefined;
        }
    }

    /**
     * Delete OAuth credentials for a user
     */
    public async deleteCredentials(userId: string): Promise<void> {
        await this.oauthStorage.deleteCredentials(userId);
    }

    /**
     * Check if user is authenticated
     */
    public async isAuthenticated(userId: string): Promise<boolean> {
        return await this.oauthStorage.hasCredentials(userId);
    }

    /**
     * Get valid access token (refresh if necessary)
     */
    public async getValidAccessToken(userId: string): Promise<string> {
        const credentials = await this.getCredentials(userId);
        
        if (!credentials) {
            throw new Error(Translations.AUTH_USER_NOT_AUTHENTICATED);
        }

        // Check if token is expired (with buffer)
        if (credentials.expiry_date && (Date.now() + OauthConfig.TOKEN_BUFFER_TIME) >= credentials.expiry_date) {
            if (credentials.refresh_token) {
                try {
                    const refreshedCredentials = await this.refreshAccessToken(credentials.refresh_token);
                    const updatedCredentials = { ...credentials, ...refreshedCredentials };
                    await this.saveCredentials(userId, updatedCredentials);
                    return updatedCredentials.access_token;
                } catch (error) {
                    throw new Error(Translations.AUTH_TOKEN_EXPIRED);
                }
            } else {
                throw new Error(Translations.AUTH_TOKEN_EXPIRED);
            }
        }

        return credentials.access_token;
    }

    /**
     * Refresh access token using refresh token
     */
    public async refreshAccessToken(refreshToken: string): Promise<Partial<IOAuthCredentials>> {

        try {
            if (!this.initialized) {
                await this.initialize();
            }

            const response = await this.http.post(GoogleOauthUrls.TOKEN, {
                headers: {
                    [HttpHeaders.CONTENT_TYPE]: ContentTypes.APPLICATION_FORM_URLENCODED,
                },
                content: `refresh_token=${encodeURIComponent(refreshToken)}&client_id=${encodeURIComponent(this.clientId)}&client_secret=${encodeURIComponent(this.clientSecret)}&grant_type=${OauthConfig.GRANT_TYPE_REFRESH_TOKEN}`,
            });

            if (response.statusCode !== 200) {
                throw new Error(`${Translations.COMMON_FAILED_REFRESH_TOKEN}: HTTP ${response.statusCode}`);
            }

            const data = JSON.parse(response.content || '{}');

            return {
                access_token: data.access_token,
                expiry_date: Date.now() + (data.expires_in * 1000),
                token_type: data.token_type,
                scope: data.scope,
            };
        } catch (error) {
            throw new Error(`${Translations.AUTH_REFRESH_TOKEN_FAILED}: ${error.message}`);
        }
    }

    /**
     * Revoke OAuth token
     */
    public async revokeToken(userId: string): Promise<boolean> {
        try {
            const credentials = await this.getCredentials(userId);
            if (!credentials) {
                return false;
            }

            // Revoke the token with Google
            if (credentials.access_token) {
                await this.http.post(`${GoogleOauthUrls.REVOKE}?token=${credentials.access_token}`);
            }

            // Delete stored credentials
            await this.deleteCredentials(userId);
            return true;
        } catch (error) {
            // Even if revoking fails, delete local credentials
            await this.deleteCredentials(userId);
            return true;
        }
    }
} 