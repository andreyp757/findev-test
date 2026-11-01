import { Routes } from "@angular/router";
import { Dashboard } from "./dashboard/dashboard";
import { Settings } from "./settings/settings";

export const routes: Routes = [
  { path: "", component: Dashboard, title: "Market overview · FinDev" },
  {
    path: "settings",
    component: Settings,
    title: "Producer settings · FinDev",
  },
  { path: "**", redirectTo: "" },
];
