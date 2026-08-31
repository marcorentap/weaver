import { notFound } from "next/navigation";

// Scratch/preview routes live under /dev. Add a page.tsx in a subfolder to
// try out components, fonts, layouts, etc. — visit at /dev/<name>.
// Hidden outside development so nothing here ships to production.
export default function DevLayout({ children }: LayoutProps<"/dev">) {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return children;
}
