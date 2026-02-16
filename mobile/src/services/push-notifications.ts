/**
 * Push notification types and stubs.
 *
 * Full implementation is deferred — this module defines the interface
 * for future Expo push notification integration.
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

/**
 * Register for push notifications.
 * Stub — returns null until Expo notification setup is implemented.
 */
export async function registerForPushNotifications(): Promise<string | null> {
  // TODO: Implement with expo-notifications
  // 1. Request permissions
  // 2. Get Expo push token
  // 3. Send token to Gateway for server-side notification dispatch
  return null;
}

/**
 * Handle incoming push notification.
 * Stub — no-op until implemented.
 */
export function handlePushNotification(_payload: PushNotificationPayload): void {
  // TODO: Route to appropriate screen / update badge count
}
