// The lucide icon an app names in <meta name="bos-app-icon">.
import { Box, Briefcase, Calendar, ClipboardList, FileText, GraduationCap, Heart, Home, Kanban, Package, Receipt, ShoppingCart, Star, Table, Users, Wallet } from "lucide-react";
import type { TabIcon } from "@/components/workbench/registry";

const ICONS: Record<string, TabIcon> = {
  users: Users, briefcase: Briefcase, table: Table, "file-text": FileText, kanban: Kanban, receipt: Receipt, box: Box,
  calendar: Calendar, heart: Heart, star: Star, "shopping-cart": ShoppingCart, package: Package, "clipboard-list": ClipboardList,
  wallet: Wallet, "graduation-cap": GraduationCap, home: Home,
};
export const appIcon = (name: string | undefined): TabIcon => (name && ICONS[name]) || Box;
