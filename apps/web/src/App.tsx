import { Router, Routes } from "./components/Router";
import { Layout } from "./components/Layout";
import { DisksPage } from "./pages/DisksPage";
import { DiskDetailPage } from "./pages/DiskDetailPage";
import { JobsPage } from "./pages/JobsPage";
import { JobDetailPage } from "./pages/JobDetailPage";

const routes = [
  { path: "/",                   component: (_p: Record<string, string>) => <DisksPage /> },
  { path: "/disks/:id",          component: (p: Record<string, string>) => <DiskDetailPage id={p.id} /> },
  { path: "/jobs",               component: (_p: Record<string, string>) => <JobsPage /> },
  { path: "/jobs/:id",           component: (p: Record<string, string>) => <JobDetailPage id={p.id} /> },
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
