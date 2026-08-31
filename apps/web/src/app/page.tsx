import { redirect } from "next/navigation";

// The app is the tab shell; chat is tab 1.
export default function Home() {
  redirect("/chat");
}
