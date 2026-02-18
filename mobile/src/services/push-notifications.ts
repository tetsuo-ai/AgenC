/**
 * Push notification integration for the mobile app.
 *
 * Uses expo-notifications when available at runtime. The integration is
 * callback-driven so the app can wire navigation and gateway token sync
 * without coupling this service to UI modules.
 */

export interface PushNotificationConfig {
  /** Expo push token */
  expoPushToken?: string;
  /** Whether notifications are enabled */
  enabled: boolean;
}

export interface PushNotificationPayload {
  messageId: string;
  sender: string;
  preview: string;
  timestamp: number;
}

interface ExpoPermissions {
  granted?: boolean;
  status?: string;
}

interface ExpoPushTokenResult {
  data?: string;
}

interface ExpoNotificationsModule {
  getPermissionsAsync?: () => Promise<ExpoPermissions>;
  requestPermissionsAsync?: () => Promise<ExpoPermissions>;
  getExpoPushTokenAsync?: (options?: { projectId?: string }) => Promise<ExpoPushTokenResult>;
  setBadgeCountAsync?: (count: number) => Promise<void>;
}

export interface PushNotificationHandlers {
  onTokenRegistered?: (token: string) => void | Promise<void>;
  onNotificationReceived?: (payload: PushNotificationPayload) => void;
  onNavigate?: (route: 'Chat' | 'Approvals', payload: PushNotificationPayload) => void;
  onBadgeCountChanged?: (count: number) => void;
}

let handlers: PushNotificationHandlers = {};
let badgeCount = 0;
let cachedModulePromise: Promise<ExpoNotificationsModule | null> | null = null;

function resolveRequire(): ((moduleName: string) => unknown) | null {
  const candidate = (globalThis as { require?: unknown }).require;
  return typeof candidate === 'function'
    ? (candidate as (moduleName: string) => unknown)
    : null;
}

function inferRoute(payload: PushNotificationPayload): 'Chat' | 'Approvals' {
  const normalized = payload.preview.toLowerCase();
  if (normalized.includes('approval') || normalized.includes('approve')) {
    return 'Approvals';
  }
  return 'Chat';
}

async function loadNotificationsModule(): Promise<ExpoNotificationsModule | null> {
  if (cachedModulePromise) {
    return cachedModulePromise;
  }

  cachedModulePromise = (async () => {
    try {
      const requireModule = resolveRequire();
      if (!requireModule) {
        return null;
      }
      const loaded = requireModule('expo-notifications') as
        | ExpoNotificationsModule
        | { default?: ExpoNotificationsModule };
      if (loaded && typeof loaded === 'object' && 'default' in loaded && loaded.default) {
        return loaded.default;
      }
      return loaded as ExpoNotificationsModule;
    } catch {
      return null;
    }
  })();

  return cachedModulePromise;
}

async function setBadgeCount(count: number): Promise<void> {
  const notifications = await loadNotificationsModule();
  if (!notifications?.setBadgeCountAsync) {
    return;
  }
  try {
    await notifications.setBadgeCountAsync(count);
  } catch {
    // Best-effort badge updates; avoid surfacing non-critical failures.
  }
}

export function setPushNotificationHandlers(nextHandlers: PushNotificationHandlers): void {
  handlers = { ...handlers, ...nextHandlers };
}

/**
 * Register for push notifications.
 * Returns Expo push token when available and permission is granted.
 */
export async function registerForPushNotifications(): Promise<string | null> {
  const notifications = await loadNotificationsModule();
  if (!notifications) {
    return null;
  }

  let permission = await notifications.getPermissionsAsync?.();
  const hasPermission = permission?.granted === true || permission?.status === 'granted';

  if (!hasPermission) {
    permission = await notifications.requestPermissionsAsync?.();
  }

  const granted = permission?.granted === true || permission?.status === 'granted';
  if (!granted) {
    return null;
  }

  const tokenResult = await notifications.getExpoPushTokenAsync?.();
  const token = typeof tokenResult?.data === 'string' ? tokenResult.data : null;

  if (!token || token.trim().length === 0) {
    return null;
  }

  await handlers.onTokenRegistered?.(token);
  return token;
}

/**
 * Handle incoming push notification.
 * Updates badge count, emits callback hooks, and routes to relevant screen.
 */
export function handlePushNotification(payload: PushNotificationPayload): void {
  badgeCount += 1;
  handlers.onBadgeCountChanged?.(badgeCount);
  void setBadgeCount(badgeCount);

  handlers.onNotificationReceived?.(payload);
  handlers.onNavigate?.(inferRoute(payload), payload);
}
