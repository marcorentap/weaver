export default function FontsPreview() {
  return (
    <div className="p-8 space-y-6">
      <h1 className="font-semibold">Font preview</h1>
      <section>
        <p className="text-muted-foreground mb-1">font-sans</p>
        <p className="font-sans">The quick brown fox 0123456789</p>
      </section>
      <section>
        <p className="text-muted-foreground mb-1">font-mono</p>
        <p className="font-mono">The quick brown fox 0O1lI 0123456789</p>
      </section>
    </div>
  );
}
