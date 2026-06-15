import { Alert, Linking, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import { useSession } from "../../lib/session";
import { Screen, Header, Card, Button, text } from "../../components/ui";
import { C } from "../../lib/theme";

function Link({ icon, label, onPress }: { icon: any; label: string; onPress: () => void }) {
  return (
    <Card onPress={onPress} style={{ marginBottom: 0 }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Ionicons name={icon} size={18} color={C.textSecondary} style={{ marginRight: 12 }} />
        <Text style={{ color: C.text, fontSize: 14, fontWeight: "500", flex: 1 }}>{label}</Text>
        <Ionicons name="chevron-forward" size={16} color={C.textMuted} />
      </View>
    </Card>
  );
}

export default function Settings() {
  const router = useRouter();
  const { apiUrl, disconnect } = useSession();
  const dashUrl = apiUrl.replace("api.", "app.");

  const onDisconnect = () => {
    Alert.alert("Disconnect", "Remove this workspace from the app?", [
      { text: "Cancel", style: "cancel" },
      { text: "Disconnect", style: "destructive", onPress: async () => { await disconnect(); router.replace("/connect"); } },
    ]);
  };

  return (
    <Screen>
      <Header eyebrow="// account" title="Settings" />

      <Card style={{ marginBottom: 18 }}>
        <Text style={text.h2}>Workspace</Text>
        <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 }}><Text style={text.sub}>API</Text><Text style={{ color: C.textLight, fontSize: 13 }}>{apiUrl.replace(/^https?:\/\//, "")}</Text></View>
        <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 }}><Text style={text.sub}>Key</Text><Text style={{ color: C.textLight, fontSize: 13 }}>•••• stored securely</Text></View>
      </Card>

      <View style={{ gap: 10, marginBottom: 18 }}>
        <Link icon="globe-outline" label="Open dashboard" onPress={() => Linking.openURL(dashUrl)} />
        <Link icon="book-outline" label="Documentation" onPress={() => Linking.openURL(`${dashUrl}/docs`)} />
        <Link icon="card-outline" label="Billing & usage" onPress={() => Linking.openURL(`${dashUrl}/billing`)} />
      </View>

      <Button title="Disconnect workspace" variant="danger" onPress={onDisconnect} />

      <Text style={{ color: C.textMuted, fontSize: 11, textAlign: "center", marginTop: 22 }}>Socheli · v{Constants.expoConfig?.version ?? "1.0.0"}</Text>
    </Screen>
  );
}
