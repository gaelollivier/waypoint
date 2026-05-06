import { Router, Routes } from "./components/Router";
import { Layout } from "./components/Layout";
import { DisksPage } from "./pages/DisksPage";
import { JobsPage } from "./pages/JobsPage";
import { JobDetailPage } from "./pages/JobDetailPage";
import { DiskExplorerPage } from "./pages/DiskExplorerPage";

const routes = [
  { path: "/",                   component: (_p: Record<string, string>) => <DisksPage /> },
  { path: "/jobs",               component: (_p: Record<string, string>) => <JobsPage /> },
  { path: "/jobs/:id",           component: (p: Record<string, string>) => <JobDetailPage id={p.id} /> },
  { path: "/disks/:id/explore",  component: (p: Record<string, string>) => <DiskExplorerPage id={p.id} /> },
];

export default function App() {
  return (
    <Router>
      <Layout>
        <Routes routes={routes} />
      </Layout>
    </Router>
  );
}
