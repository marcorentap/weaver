import Link from "next/link";

const pages = [
  { href: "/dev/blocks", label: "Blocks" },
  { href: "/dev/fonts", label: "Fonts" },
  { href: "/dev/graphs", label: "Graphs" },
];

export default function DevIndex() {
  return (
    <div className="p-8 space-y-2">
      <h1 className="font-semibold">Dev pages</h1>
      <ul className="list-disc pl-5">
        {pages.map((p) => (
          <li key={p.href}>
            <Link className="underline" href={p.href}>
              {p.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
