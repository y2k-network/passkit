import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="flex flex-col justify-center text-center flex-1 gap-4 max-w-2xl mx-auto px-4">
      <h1 className="text-3xl font-bold">@y2k-network/passkit</h1>
      <p className="text-fd-muted-foreground">
        An Effect-native library for Apple Wallet and Google Wallet passes:
        one neutral pass IR, two compile targets.
      </p>
      <p>
        <Link href="/docs" className="font-medium underline">
          Get started &rarr;
        </Link>
      </p>
    </div>
  );
}
