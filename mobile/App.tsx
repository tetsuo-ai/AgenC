import React, { useState, useCallback } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text } from 'react-native';
import type { GatewayConnection, GatewayStatusInfo } from './src/types';
import { useRemoteGateway } from './src/hooks/useRemoteGateway';
import { useChat } from './src/hooks/useChat';
import { ChatScreen } from './src/screens/ChatScreen';
import { DashboardScreen } from './src/screens/DashboardScreen';
import { ApprovalScreen } from './src/screens/ApprovalScreen';

const Tab = createBottomTabNavigator();

export default function App() {
  // Gateway connection state — loaded from settings or deep link
  const [connection, setConnection] = useState<GatewayConnection | null>(null);
  const [gatewayInfo, setGatewayInfo] = useState<GatewayStatusInfo | null>(null);

  const { status, send, disconnect, switchGateway, queueSize } = useRemoteGateway({
    connection,
    onMessage: (data) => {
      handleIncoming(data);

      // Handle status broadcasts
      if (data && typeof data === 'object') {
        const msg = data as Record<string, unknown>;
        if (msg.type === 'status' && msg.payload && typeof msg.payload === 'object') {
          const p = msg.payload as Record<string, unknown>;
          setGatewayInfo({
            state: typeof p.state === 'string' ? p.state : 'unknown',
            uptimeMs: typeof p.uptimeMs === 'number' ? p.uptimeMs : 0,
            channels: Array.isArray(p.channels) ? (p.channels as string[]) : [],
            activeSessions: typeof p.activeSessions === 'number' ? p.activeSessions : 0,
          });
        }
      }
    },
    onAuthFailed: (reason) => {
      console.warn('Auth failed:', reason);
    },
  });

  const { messages, approvalRequests, sendMessage, handleIncoming, clearMessages, respondToApproval } = useChat(send);

  const handleApprove = useCallback((id: string) => respondToApproval(id, true), [respondToApproval]);
  const handleDeny = useCallback((id: string) => respondToApproval(id, false), [respondToApproval]);

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <Tab.Navigator
          screenOptions={{
            headerShown: false,
            tabBarActiveTintColor: '#007AFF',
          }}
        >
          <Tab.Screen
            name="Chat"
            options={{
              tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 20 }}>&#x1F4AC;</Text>,
            }}
          >
            {() => (
              <ChatScreen
                connection={connection}
                status={status}
                queueSize={queueSize}
                messages={messages}
                sendMessage={sendMessage}
              />
            )}
          </Tab.Screen>
          <Tab.Screen
            name="Dashboard"
            options={{
              tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 20 }}>&#x1F4CA;</Text>,
            }}
          >
            {() => <DashboardScreen status={status} gatewayInfo={gatewayInfo} />}
          </Tab.Screen>
          <Tab.Screen
            name="Approvals"
            options={{
              tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 20 }}>&#x2705;</Text>,
              tabBarBadge: approvalRequests.length > 0 ? approvalRequests.length : undefined,
            }}
          >
            {() => (
              <ApprovalScreen
                requests={approvalRequests}
                onApprove={handleApprove}
                onDeny={handleDeny}
              />
            )}
          </Tab.Screen>
        </Tab.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
