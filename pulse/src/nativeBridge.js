import { NativeModules, Platform } from 'react-native';

const bridge = NativeModules.NotificationBridgeModule;

export const NotificationBridge = {
  isAvailable: Platform.OS === 'android' && !!bridge,
  checkNotificationAccess: async () => {
    if (!bridge?.checkNotificationAccess) return false;
    return bridge.checkNotificationAccess();
  },
  openNotificationAccessSettings: async () => {
    if (!bridge?.openNotificationAccessSettings) return;
    return bridge.openNotificationAccessSettings();
  },
  getInstalledBankingApps: async () => {
    if (!bridge?.getInstalledBankingApps) return [];
    return bridge.getInstalledBankingApps();
  },
  getApplicationIcon: async (packageName) => {
    if (!bridge?.getApplicationIcon) return null;
    return bridge.getApplicationIcon(packageName);
  },
  seedDemoNotifications: async () => {
    if (!bridge?.seedDemoNotifications) return;
    return bridge.seedDemoNotifications();
  },
};
