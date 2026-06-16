import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DeviceEventEmitter,
  FlatList,
  Modal,
  PanResponder,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Image,
  Platform,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Canvas, Group, Path, Skia } from '@shopify/react-native-skia';
import { VictoryAxis, VictoryBar, VictoryChart, VictoryLine, VictoryPie, VictoryTheme } from 'victory-native';
import {
  addNotificationLog,
  bootstrapDb,
  confirmTransaction,
  deleteTransaction,
  getCategories,
  getCategorySpendForMonth,
  getMerchantMemories,
  getMonthlyTotals,
  getSetting,
  getTransactions,
  insertTransaction,
  saveMerchantMemory,
  setSetting,
  updateTransaction,
} from './src/db';
import { findMerchantMemory, normalizeMerchantName, parseNotificationText } from './src/parser';
import { NotificationBridge } from './src/nativeBridge';

const BG = '#0A0A0F';
const CARD = 'rgba(255,255,255,0.05)';

const mockNotifications = [
  { sourceApp: 'com.google.android.apps.walletnfcrel', rawText: 'You paid ₹450 to Zomato' },
  { sourceApp: 'com.google.android.gm', rawText: 'Payment of $12.99 to Netflix confirmed' },
  { sourceApp: 'com.whatsapp', rawText: '₹45,000 credited to your account from ACME Payroll' },
  { sourceApp: 'com.bank.app', rawText: 'Transaction alert: INR 500.00 spent at Uber' },
];

const formatAmount = (amount, currency, type) => `${type === 'debit' ? '-' : '+'}${currency} ${Number(amount || 0).toFixed(2)}`;

const groupByDay = (transactions) =>
  transactions.reduce((acc, tx) => {
    const key = new Date(tx.created_at).toDateString();
    if (!acc[key]) acc[key] = [];
    acc[key].push(tx);
    return acc;
  }, {});

const ringPath = (start, sweep, radius) => {
  const path = Skia.Path.Make();
  const rect = { x: 12, y: 12, width: radius * 2, height: radius * 2 };
  path.addArc(rect, start, sweep);
  return path;
};

function SwipeCard({ tx, onConfirm, onDelete, onEdit, iconUri }) {
  const [translateX, setTranslateX] = useState(0);
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 12,
        onPanResponderMove: (_, g) => setTranslateX(g.dx),
        onPanResponderRelease: async (_, g) => {
          if (g.dx > 90) {
            await onConfirm(tx.id);
          } else if (g.dx < -90) {
            await onDelete(tx.id);
          }
          setTranslateX(0);
        },
      }),
    [tx.id, onConfirm, onDelete]
  );

  return (
    <Pressable onPress={() => onEdit(tx)} style={[styles.transactionCard, { transform: [{ translateX }] }]} {...panResponder.panHandlers}>
      <View style={styles.txLeft}>
        {iconUri ? <Image source={{ uri: iconUri }} style={styles.appIcon} /> : <Text style={styles.appFallback}>{(tx.source_app || '?')[0]}</Text>}
        <View>
          <Text style={styles.merchant}>{tx.merchant}</Text>
          <View style={styles.row}>
            <Text style={[styles.categoryChip, { backgroundColor: `${tx.category_color || '#9CA3AF'}40` }]}>
              {tx.category_emoji || '🏷️'} {tx.category_name || 'Uncategorized'}
            </Text>
            {tx.confidence < 0.7 && <Text style={styles.confBadge}>low confidence</Text>}
          </View>
        </View>
      </View>
      <Text style={[styles.amount, { color: tx.type === 'debit' ? '#F87171' : '#34D399' }]}>{formatAmount(tx.amount, tx.currency, tx.type)}</Text>
    </Pressable>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [locked, setLocked] = useState(true);
  const [onboarded, setOnboarded] = useState(false);
  const [transactions, setTransactions] = useState([]);
  const [categories, setCategories] = useState([]);
  const [merchantMemories, setMerchantMemories] = useState([]);
  const [editingTx, setEditingTx] = useState(null);
  const [loan, setLoan] = useState({ principal: '100000', rate: '12', term: '24', target: '10000' });
  const [appIcons, setAppIcons] = useState({});
  const pollRef = useRef(null);

  const refreshAll = async () => {
    const [txs, cats, memories] = await Promise.all([getTransactions(), getCategories(), getMerchantMemories()]);
    setTransactions(txs);
    setCategories(cats);
    setMerchantMemories(memories);
    if (NotificationBridge.isAvailable) {
      const next = {};
      for (const pkg of [...new Set(txs.map((t) => t.source_app).filter(Boolean))]) {
        if (!next[pkg]) next[pkg] = await NotificationBridge.getApplicationIcon(pkg);
      }
      setAppIcons(next);
    }
  };

  const authenticate = async () => {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    if (!hasHardware || !enrolled) {
      setLocked(false);
      return;
    }
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock Pulse' });
    setLocked(!result.success);
  };

  useEffect(() => {
    (async () => {
      await bootstrapDb();
      const enabled = (await getSetting('notificationServiceEnabled')) === 'true';
      setOnboarded(enabled);
      await authenticate();
      await refreshAll();
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!ready) return;
    const listener = DeviceEventEmitter.addListener('PulseNotificationReceived', async (payload) => {
      const rawText = [payload?.title, payload?.text, payload?.subText, payload?.bigText].filter(Boolean).join(' ');
      const sourceApp = payload?.sourceApp || 'unknown';
      await addNotificationLog({ sourceApp, rawText, extras: payload });
      const parsed = parseNotificationText({ rawText, sourceApp });
      const memory = findMerchantMemory(parsed.merchant, merchantMemories);
      const categoryId = memory?.category_id;
      const txId = await insertTransaction({ ...parsed, categoryId, confirmed: parsed.confidence >= 0.7 });
      if (parsed.confidence < 0.7) {
        const txs = await getTransactions();
        const tx = txs.find((t) => t.id === txId);
        setEditingTx(tx || null);
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await refreshAll();
    });
    return () => listener.remove();
  }, [ready, merchantMemories]);

  useEffect(() => {
    if (!onboarded) {
      pollRef.current = setInterval(async () => {
        if (!NotificationBridge.isAvailable) return;
        const enabled = await NotificationBridge.checkNotificationAccess();
        if (enabled) {
          await setSetting('notificationServiceEnabled', 'true');
          setOnboarded(true);
          clearInterval(pollRef.current);
        }
      }, 1000);
    }
    return () => pollRef.current && clearInterval(pollRef.current);
  }, [onboarded]);

  const monthly = useMemo(() => {
    const monthMap = {};
    for (const t of transactions) {
      const m = t.created_at.slice(0, 7);
      monthMap[m] ||= { month: m, income: 0, expense: 0 };
      monthMap[m][t.type === 'credit' ? 'income' : 'expense'] += Number(t.amount || 0);
    }
    return Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month)).slice(-6);
  }, [transactions]);

  const currentMonth = new Date().toISOString().slice(0, 7);
  const thisMonth = monthly.find((m) => m.month === currentMonth) || { income: 0, expense: 0 };
  const savingsRate = thisMonth.income > 0 ? ((thisMonth.income - thisMonth.expense) / thisMonth.income) * 100 : 0;
  const day = new Date().getDate();
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const projectedExpense = day ? (thisMonth.expense / day) * daysInMonth : 0;
  const projectedBalance = thisMonth.income - projectedExpense;
  const target = Number(loan.target || 0);
  const affordableMonthly = ((thisMonth.income || 0) - (thisMonth.expense || 0)) * 0.4;
  const rate = Number(loan.rate || 0) / 1200;
  const term = Number(loan.term || 0);
  const principal = Number(loan.principal || 0);
  const emi = rate > 0 && term > 0 ? (principal * rate * (1 + rate) ** term) / ((1 + rate) ** term - 1) : 0;

  const onConfirm = async (id) => {
    await confirmTransaction(id);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await refreshAll();
  };

  const onDelete = async (id) => {
    await deleteTransaction(id);
    await refreshAll();
  };

  const exportCsv = async () => {
    const rows = await getTransactions();
    const header = 'id,amount,currency,merchant,type,category,source_app,confidence,confirmed,created_at';
    const body = rows
      .map((r) =>
        [r.id, r.amount, r.currency, `"${r.merchant}"`, r.type, `"${r.category_name || ''}"`, r.source_app, r.confidence, r.confirmed, r.created_at].join(',')
      )
      .join('\n');
    const path = `${FileSystem.cacheDirectory}pulse-export.csv`;
    await FileSystem.writeAsStringAsync(path, `${header}\n${body}`);
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(path);
  };

  const applyEdit = async () => {
    if (!editingTx) return;
    await updateTransaction(editingTx.id, {
      amount: Number(editingTx.amount),
      currency: editingTx.currency,
      merchant: editingTx.merchant,
      type: editingTx.type,
      categoryId: editingTx.category_id,
      confidence: Math.max(Number(editingTx.confidence || 0.8), 0.8),
      confirmed: true,
      rawText: editingTx.raw_text,
    });
    if (editingTx.category_id) {
      await saveMerchantMemory(normalizeMerchantName(editingTx.merchant), editingTx.category_id);
    }
    setEditingTx(null);
    await refreshAll();
  };

  const grouped = groupByDay(transactions);

  if (!ready) return <SafeAreaView style={styles.container}><Text style={styles.title}>Booting Pulse...</Text></SafeAreaView>;

  if (locked) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.title}>Pulse is locked 🔐</Text>
        <Pressable onPress={authenticate} style={styles.cta}><Text style={styles.ctaText}>Unlock</Text></Pressable>
      </SafeAreaView>
    );
  }

  if (!onboarded) {
    return (
      <SafeAreaView style={styles.container}>
        <LinearGradient colors={['#7C3AED', '#06B6D4']} style={styles.hero}>
          <Text style={styles.title}>Allow Notification Access</Text>
          <Text style={styles.subtitle}>Pulse reads payment alerts only. Nothing leaves your phone.</Text>
        </LinearGradient>
        <Pressable
          style={styles.cta}
          onPress={async () => {
            if (NotificationBridge.isAvailable) {
              await NotificationBridge.openNotificationAccessSettings();
            }
          }}
        >
          <Text style={styles.ctaText}>Open Android Settings</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const latestMonthPie = monthly.length
    ? [
        { x: 'Spend', y: monthly[monthly.length - 1].expense || 1 },
        { x: 'Income', y: monthly[monthly.length - 1].income || 1 },
      ]
    : [];

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={{ paddingBottom: 80 }}>
        <Text style={styles.title}>Pulse</Text>

        <BlurView intensity={30} tint="dark" style={styles.card}>
          <Text style={styles.sectionTitle}>Home Breakdown</Text>
          <Canvas style={{ width: 210, height: 210, alignSelf: 'center' }}>
            <Group transform={[{ translateX: 0 }, { translateY: 0 }]}> 
              {(() => {
                let start = -90;
                const total = thisMonth.expense || 1;
                const categoryTotals = Object.values(
                  transactions
                    .filter((t) => t.type === 'debit' && t.created_at.startsWith(currentMonth))
                    .reduce((acc, t) => {
                      const k = t.category_name || 'Uncategorized';
                      acc[k] ||= { value: 0, color: t.category_color || '#9CA3AF' };
                      acc[k].value += Number(t.amount || 0);
                      return acc;
                    }, {})
                );
                return categoryTotals.map((seg, index) => {
                  const sweep = (seg.value / total) * 360;
                  const p = ringPath(start, sweep, 90);
                  start += sweep;
                  return <Path key={`${index}-${seg.color}`} path={p} color={seg.color} style="stroke" strokeWidth={18} strokeCap="round" />;
                });
              })()}
            </Group>
          </Canvas>
          <Text style={styles.metric}>Savings rate: {savingsRate.toFixed(1)}%</Text>
          <Text style={styles.metric}>Projected month-end balance: {projectedBalance.toFixed(0)}</Text>
          <Text style={[styles.targetCard, { color: projectedBalance > target ? '#34D399' : '#F87171' }]}>Room for investment: {projectedBalance > target ? 'On Track' : 'Below Target'}</Text>
        </BlurView>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Insights</Text>
          <VictoryChart theme={VictoryTheme.material} domainPadding={20} height={220}>
            <VictoryAxis tickFormat={(x) => x.slice(5)} style={{ tickLabels: { fill: '#E5E7EB', fontSize: 10 } }} />
            <VictoryAxis dependentAxis style={{ tickLabels: { fill: '#E5E7EB', fontSize: 10 } }} />
            <VictoryBar data={monthly} x="month" y="expense" style={{ data: { fill: '#F87171' } }} />
          </VictoryChart>
          <VictoryChart theme={VictoryTheme.material} height={220}>
            <VictoryAxis tickFormat={(x) => x.slice(5)} style={{ tickLabels: { fill: '#E5E7EB', fontSize: 10 } }} />
            <VictoryAxis dependentAxis style={{ tickLabels: { fill: '#E5E7EB', fontSize: 10 } }} />
            <VictoryLine data={monthly} x="month" y="expense" style={{ data: { stroke: '#22D3EE', strokeWidth: 3 } }} />
          </VictoryChart>
          {latestMonthPie.length > 0 && (
            <VictoryPie
              height={220}
              data={latestMonthPie}
              colorScale={['#F87171', '#34D399']}
              style={{ labels: { fill: '#E5E7EB', fontSize: 12 } }}
              innerRadius={55}
            />
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Loan affordability</Text>
          <View style={styles.rowWrap}>
            <TextInput value={loan.principal} onChangeText={(v) => setLoan((l) => ({ ...l, principal: v }))} style={styles.input} placeholder="Principal" placeholderTextColor="#94A3B8" keyboardType="numeric" />
            <TextInput value={loan.rate} onChangeText={(v) => setLoan((l) => ({ ...l, rate: v }))} style={styles.input} placeholder="Rate %" placeholderTextColor="#94A3B8" keyboardType="numeric" />
            <TextInput value={loan.term} onChangeText={(v) => setLoan((l) => ({ ...l, term: v }))} style={styles.input} placeholder="Term" placeholderTextColor="#94A3B8" keyboardType="numeric" />
          </View>
          <Text style={styles.metric}>Affordable monthly: {affordableMonthly.toFixed(0)}</Text>
          <Text style={[styles.targetCard, { color: emi <= affordableMonthly ? '#34D399' : '#F87171' }]}>{emi <= affordableMonthly ? 'Affordable ✅' : 'Too risky ⚠️'} | EMI {emi.toFixed(0)}</Text>
        </View>

        <View style={styles.rowWrap}>
          <Pressable style={styles.secondaryCta} onPress={exportCsv}><Text style={styles.ctaText}>Export CSV</Text></Pressable>
          <Pressable
            style={styles.secondaryCta}
            onPress={async () => {
              if (NotificationBridge.isAvailable) {
                await NotificationBridge.seedDemoNotifications();
              } else {
                for (const mock of mockNotifications) {
                  const parsed = parseNotificationText(mock);
                  const memory = findMerchantMemory(parsed.merchant, merchantMemories);
                  await insertTransaction({ ...parsed, categoryId: memory?.category_id, confirmed: parsed.confidence >= 0.7 });
                }
                await refreshAll();
              }
            }}
          >
            <Text style={styles.ctaText}>Seed Demo Alerts</Text>
          </Pressable>
        </View>

        <Text style={styles.sectionTitle}>Transactions</Text>
        {Object.entries(grouped).map(([dayKey, items]) => (
          <View key={dayKey}>
            <Text style={styles.dayHeading}>{dayKey}</Text>
            {items.map((tx) => (
              <SwipeCard
                key={tx.id}
                tx={tx}
                iconUri={appIcons[tx.source_app]}
                onConfirm={onConfirm}
                onDelete={onDelete}
                onEdit={(item) => setEditingTx(item)}
              />
            ))}
          </View>
        ))}
      </ScrollView>

      <Modal transparent visible={!!editingTx} animationType="slide" onRequestClose={() => setEditingTx(null)}>
        <View style={styles.sheetWrap}>
          <View style={styles.sheet}>
            <Text style={styles.sectionTitle}>Confirm transaction</Text>
            <TextInput style={styles.fullInput} value={String(editingTx?.merchant || '')} onChangeText={(v) => setEditingTx((t) => ({ ...t, merchant: v }))} />
            <TextInput style={styles.fullInput} value={String(editingTx?.amount || '')} onChangeText={(v) => setEditingTx((t) => ({ ...t, amount: v }))} keyboardType="numeric" />
            <TextInput style={styles.fullInput} value={String(editingTx?.currency || '')} onChangeText={(v) => setEditingTx((t) => ({ ...t, currency: v }))} />
            <View style={styles.rowWrap}>
              <Pressable style={styles.secondaryCta} onPress={() => setEditingTx(null)}><Text style={styles.ctaText}>Cancel</Text></Pressable>
              <Pressable style={styles.cta} onPress={applyEdit}><Text style={styles.ctaText}>Save</Text></Pressable>
            </View>
            <FlatList
              data={categories}
              horizontal
              keyExtractor={(item) => String(item.id)}
              renderItem={({ item }) => (
                <Pressable onPress={() => setEditingTx((t) => ({ ...t, category_id: item.id }))} style={[styles.categoryPicker, editingTx?.category_id === item.id && { borderColor: item.color }]}> 
                  <Text style={{ color: '#fff' }}>{item.emoji} {item.name}</Text>
                </Pressable>
              )}
            />
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG, paddingHorizontal: 16 },
  hero: { borderRadius: 20, padding: 20, marginTop: 24 },
  title: { color: '#fff', fontSize: 34, fontWeight: '800', marginVertical: 16 },
  subtitle: { color: '#CBD5E1', fontSize: 16, marginTop: 8 },
  card: {
    backgroundColor: CARD,
    borderRadius: 18,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  sectionTitle: { color: '#E2E8F0', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  cta: {
    backgroundColor: '#7C3AED',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignSelf: 'flex-start',
    marginVertical: 10,
  },
  secondaryCta: {
    backgroundColor: '#1E293B',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginVertical: 10,
  },
  ctaText: { color: '#fff', fontWeight: '700' },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center' },
  metric: { color: '#94A3B8', fontSize: 14, marginBottom: 4 },
  targetCard: { fontSize: 15, fontWeight: '700', marginTop: 6 },
  dayHeading: { color: '#A5B4FC', fontWeight: '700', marginTop: 12, marginBottom: 8 },
  transactionCard: {
    backgroundColor: 'rgba(15,23,42,0.7)',
    borderRadius: 14,
    padding: 12,
    marginBottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  txLeft: { flexDirection: 'row', gap: 10, alignItems: 'center', flexShrink: 1 },
  merchant: { color: '#fff', fontWeight: '700', fontSize: 16 },
  categoryChip: { color: '#E2E8F0', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, overflow: 'hidden', marginTop: 4, marginRight: 6 },
  confBadge: { color: '#FBBF24', fontSize: 12, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center' },
  amount: { fontWeight: '800', fontSize: 15 },
  sheetWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { backgroundColor: '#111827', borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16, gap: 10, maxHeight: '65%' },
  fullInput: { borderRadius: 12, borderWidth: 1, borderColor: '#334155', color: '#fff', padding: 10 },
  input: { minWidth: 100, borderRadius: 12, borderWidth: 1, borderColor: '#334155', color: '#fff', paddingHorizontal: 10, paddingVertical: 8 },
  categoryPicker: { borderWidth: 1, borderColor: '#334155', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, marginRight: 8 },
  appIcon: { width: 26, height: 26, borderRadius: 6 },
  appFallback: { width: 26, height: 26, textAlign: 'center', textAlignVertical: 'center', color: '#94A3B8', borderRadius: 6, backgroundColor: '#1E293B' },
});
