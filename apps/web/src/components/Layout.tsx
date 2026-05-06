import { Link, useLocation } from "./Router";

export function Layout({ children }: { children: React.ReactNode }) {
  const { path } = useLocation();

  const navLink = (href: string, label: string) => (
    <Link
      href={href}
      className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
        path === href || (href !== "/" && path.startsWith(href))
          ? "bg-zinc-700 text-white"
          : "text-zinc-400 hover:text-white"
      }`}
    >
      {label}
    </Link>
  );

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      <header className="border-b border-zinc-800 px-6 py-3 flex items-center gap-6">
        <Link href="/" className="font-semibold text-white tracking-tight">
          Waypoint
        </Link>
        <nav className="flex items-center gap-1">
          {navLink("/", "Disks")}
          {navLink("/jobs", "Jobs")}
        </nav>
      </header>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
