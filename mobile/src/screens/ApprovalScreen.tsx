import React from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ApprovalRequest } from '../types';

interface ApprovalScreenProps {
  requests: ApprovalRequest[];
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}

export function ApprovalScreen({ requests, onApprove, onDeny }: ApprovalScreenProps) {
  const renderItem = ({ item }: { item: ApprovalRequest }) => (
    <View style={styles.card}>
      <Text style={styles.tool}>{item.tool}</Text>
      <Text style={styles.reason}>{item.reason}</Text>
      <Text style={styles.timestamp}>
        {new Date(item.timestamp).toLocaleTimeString()}
      </Text>

      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.button, styles.denyButton]}
          onPress={() => onDeny(item.id)}
        >
          <Text style={styles.denyText}>Deny</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, styles.approveButton]}
          onPress={() => onApprove(item.id)}
        >
          <Text style={styles.approveText}>Approve</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>Pending Approvals</Text>
      {requests.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No pending approvals</Text>
        </View>
      ) : (
        <FlatList
          data={requests}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
        />
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
    marginBottom: 12,
  },
  tool: {
    fontSize: 16,
    fontWeight: '700',
    color: '#000000',
    marginBottom: 4,
  },
  reason: {
    fontSize: 14,
    color: '#3C3C43',
    marginBottom: 8,
  },
  timestamp: {
    fontSize: 12,
    color: '#8E8E93',
    marginBottom: 12,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  button: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 8,
  },
  approveButton: {
    backgroundColor: '#34C759',
  },
  denyButton: {
    backgroundColor: '#FF3B30',
  },
  approveText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 14,
  },
  denyText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 14,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 16,
    color: '#8E8E93',
  },
});
