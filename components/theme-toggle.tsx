"use client";

import { memo, useCallback } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";

function ThemeToggleImpl() {
  const { setTheme } = useTheme();
  // Why: stable callbacks prevent the DropdownMenuItem children from
  // invalidating when the parent (orchestrator) re-renders on every poll.
  const setLight = useCallback(() => setTheme("light"), [setTheme]);
  const setDark = useCallback(() => setTheme("dark"), [setTheme]);
  const setSystem = useCallback(() => setTheme("system"), [setTheme]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs">
          <Sun className="scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
          <Moon className="absolute scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
          <span className="sr-only">Toggle theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={setLight}>Light</DropdownMenuItem>
        <DropdownMenuItem onClick={setDark}>Dark</DropdownMenuItem>
        <DropdownMenuItem onClick={setSystem}>System</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Why: no props, so memo means it never re-renders unless next-themes' context
// notifies a theme change. Without memo, every orchestrator re-render
// (every poll cycle) walked through this component.
export const ThemeToggle = memo(ThemeToggleImpl);
