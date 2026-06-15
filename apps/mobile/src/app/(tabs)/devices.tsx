import { RefreshControl, Text, View } from "react-native";
import { useSession } from "../../lib/session";
import { useAsync } from "../../lib/hooks";
import { Screen, Header, Card, Badge, Stat, Loading, Empty, text } from "../../components/ui";
import { C, statusColor } from "../../lib/theme";
import type { FleetState } from "../../lib/socheli";

export default function Devices() {
  const { client } = useSession();
  const { data, loading, reload } = useAsync<FleetState>(() => client!.fleet(), []);
  const jobs = data?.jobs ?? [];
  const done = jobs.filter((j) => j.status === "done").length;

  return (
    <Screen refreshControl={<RefreshControl refreshing={loading} onRefresh={reload} tintColor={C.textSecondary} />}>
      <Header eyebrow="// fleet" title="Devices" sub="Capability-matched render fleet." />

      <View style={{ flexDirection: "row", gap: 10, marginBottom: 14 }}>
        <Stat label="Online" value={data?.online ?? "—"} foot={`${data?.devices.length ?? 0} total`} />
        <Stat label="Jobs done" value={done} foot={`${jobs.length} recent`} />
      </View>

      {loading && !data ? <Loading /> : (data?.devices.length ?? 0) === 0 ? <Empty>No devices have connected yet.</Empty> : (
        <View style={{ gap: 10 }}>
          {data!.devices.map((d) => (
            <Card key={d.device}>
              <View style={{ flexDirection: "row", alignItems: "center", marginBottom: d.caps?.length ? 10 : 0 }}>
                <View style={{ width: 9, height: 9, borderRadius: 5, marginRight: 10, backgroundColor: statusColor(d.status) }} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: C.text, fontWeight: "700", fontSize: 15 }}>{d.device}</Text>
                  {d.profile && <Text style={text.sub}>{d.profile.arch} · {d.profile.cpus} cores · {d.profile.ramGb}GB · {d.profile.gpu}</Text>}
                  {d.host && <Text style={text.sub}>{d.host}</Text>}
                </View>
                <Badge label={d.status} color={statusColor(d.status)} />
              </View>
              {d.caps && d.caps.length > 0 && (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {d.caps.map((c) => (
                    <View key={c} style={{ borderWidth: 1, borderColor: C.border, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                      <Text style={{ color: C.textSecondary, fontSize: 10.5 }}>{c}</Text>
                    </View>
                  ))}
                </View>
              )}
            </Card>
          ))}
        </View>
      )}

      <Text style={[text.h2, { marginTop: 22 }]}>Recent jobs</Text>
      {jobs.length === 0 ? <Empty>No jobs dispatched yet.</Empty> : (
        <View style={{ gap: 10 }}>
          {jobs.slice(0, 12).map((j) => (
            <Card key={j.id}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Badge label={j.status} color={statusColor(j.status)} />
                <Text style={{ color: C.text, fontWeight: "600" }}>{j.type}</Text>
                {j.device && <Text style={text.sub}>on {j.device}</Text>}
                {j.channel && <Text style={[text.sub, { marginLeft: "auto" }]}>{j.channel}</Text>}
              </View>
              {j.message ? <Text style={{ color: C.error, fontSize: 12, marginTop: 6 }}>{j.message}</Text> : null}
            </Card>
          ))}
        </View>
      )}
    </Screen>
  );
}
