import { FlightMap } from "@/components/FlightMap";
import { SidebarProvider } from "@/components/ui/sidebar";

export default function HomePage() {
  return (
    <SidebarProvider>
      <FlightMap />
    </SidebarProvider>
  );
}
