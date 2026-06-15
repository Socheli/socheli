import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { useSession } from "../lib/session";
import { C } from "../lib/theme";

export default function Index() {
  const { ready, connected } = useSession();
  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={C.textSecondary} />
      </View>
    );
  }
  return <Redirect href={connected ? "/(tabs)/home" : "/connect"} />;
}
