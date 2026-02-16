import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ConnectionStatus, GatewayStatusInfo } from '../types';

interface DashboardScreenProps {
  status: ConnectionStatus;
  gatewayInfo: GatewayStatusInfo | null;
}

export function DashboardScreen({ status, gatewayInfo }: DashboardScreenProps) {
  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>Gateway Status</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Connection</Text>
        <Text style={[styles.value, { color: status === 'connected' ? '#34C759' : '#FF3B30' }]}>
          {status}
        </Text>
      </View>

      {gatewayInfo && (
        <>
          <View style={styles.card}>
            <Text style={styles.label}>Gateway State</Text>
            <Text style={styles.value}>{gatewayInfo.state}</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.label}>Uptime</Text>
            <Text style={styles.value}>
              {Math.floor(gatewayInfo.uptimeMs / 1000)}s
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.label}>Active Sessions</Text>
            <Text style={styles.value}>{gatewayInfo.activeSessions}</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.label}>Channels</Text>
            <Text style={styles.value}>
              {gatewayInfo.channels.length > 0
                ? gatewayInfo.channels.join(', ')
                : 'None'}
            </Text>
          </View>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
    padding: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 16,
    color: '#000000',
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  label: {
    fontSize: 16,
    color: '#8E8E93',
  },
  value: {
    fontSize: 16,
    fontWeight: '600',
    color: '#000000',
  },
});
