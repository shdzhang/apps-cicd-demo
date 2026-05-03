import {
  Router,
  type Request,
  type Response,
  type Router as RouterType,
} from 'express';
import { isDatabaseAvailable } from '@chat-template/db';
import { getEndpointOboInfo } from '@chat-template/ai-sdk-providers';
import { getDatabricksOAuthToken } from '@chat-template/auth';

function getHostUrl(): string | null {
  const raw = process.env.DATABRICKS_HOST;
  if (!raw) return null;
  return `https://${raw.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
}

export const configRouter: RouterType = Router();

/**
 * Extract OAuth scopes from a JWT token (without verification).
 * Databricks tokens use 'scope' (space-separated string) or 'scp' (array).
 */
function getScopesFromToken(token: string): string[] {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return [];
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    if (typeof payload.scope === 'string') return payload.scope.split(' ');
    if (Array.isArray(payload.scp)) return payload.scp as string[];
    return [];
  } catch {
    return [];
  }
}

/**
 * Read the live deployment's Git ref from the Apps API.
 *
 * Git-backed deploys carry the deployed tag/branch/commit + resolved_commit
 * directly on the deployment record, so this is the source of truth — the
 * old env-var pattern (`APP_VERSION`/`APP_GIT_REF`) doesn't survive Git-backed
 * because the repo's `app.yaml` overrides `databricks.yml`'s `config.env`.
 *
 * Falls back to env vars (so local dev still shows something) and finally
 * to `local-dev` / `local`.
 */
type Version = { sha: string; ref: string };
let versionCache: { value: Version; expiresAt: number } | null = null;
const VERSION_CACHE_MS = 5 * 60 * 1000;

async function fetchDeployedVersion(): Promise<Version> {
  if (versionCache && Date.now() < versionCache.expiresAt) {
    return versionCache.value;
  }

  const fallback: Version = {
    sha: process.env.APP_VERSION ?? 'local-dev',
    ref: process.env.APP_GIT_REF ?? 'local',
  };

  // DATABRICKS_APP_NAME is set by the platform when running in a Databricks App.
  // Locally, this is unset — return the env-var fallback.
  const appName = process.env.DATABRICKS_APP_NAME;
  const hostUrl = getHostUrl();
  if (!appName || !hostUrl) return fallback;

  try {
    const token = await getDatabricksOAuthToken();
    const res = await fetch(`${hostUrl.replace(/\/$/, '')}/api/2.0/apps/${encodeURIComponent(appName)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return fallback;
    const app = (await res.json()) as {
      active_deployment?: {
        git_source?: { tag?: string; branch?: string; commit?: string; resolved_commit?: string };
      };
    };
    const gs = app.active_deployment?.git_source;
    if (!gs) return fallback;
    const version: Version = {
      sha: gs.resolved_commit ?? gs.commit ?? fallback.sha,
      ref: gs.tag ?? gs.branch ?? gs.commit ?? fallback.ref,
    };
    versionCache = { value: version, expiresAt: Date.now() + VERSION_CACHE_MS };
    return version;
  } catch {
    return fallback;
  }
}

/**
 * GET /api/config - Get application configuration
 * Returns feature flags and OBO status based on environment configuration.
 * If the user's OBO token is present, decodes it to check which required
 * scopes are missing — the banner only shows missing scopes.
 */
configRouter.get('/', async (req: Request, res: Response) => {
  const oboInfo = await getEndpointOboInfo();

  let missingScopes = oboInfo.endpointRequiredScopes;

  // If the user has an OBO token, check which scopes are already present
  const userToken = req.headers['x-forwarded-access-token'] as string | undefined;
  if (userToken && oboInfo.isEndpointOboEnabled) {
    const tokenScopes = getScopesFromToken(userToken);
    // A required scope like "sql.statement-execution" is satisfied by
    // an exact match OR by its parent prefix (e.g. "sql")
    missingScopes = oboInfo.endpointRequiredScopes.filter(required => {
      const parent = required.split('.')[0];
      return !tokenScopes.some(ts => ts === required || ts === parent);
    });
  }

  const version = await fetchDeployedVersion();

  res.json({
    features: {
      chatHistory: isDatabaseAvailable(),
      feedback: !!process.env.MLFLOW_EXPERIMENT_ID,
    },
    obo: {
      missingScopes,
    },
    version,
  });
});
