import React from "react";

import { ThemeProvider } from "@/state/theme/ThemeProvider";
import { FollowProvider } from "@/state/follow/FollowProvider";
import { CustomCategoriesProvider } from "@/state/customCategories/CustomCategoriesProvider";
import { PlayerUiProvider } from "@/state/playerUi/PlayerUiProvider";
import { CategoryProvider } from "@/state/category/CategoryProvider";
import { ActiveStreamsProvider } from "@/state/activeStreams/ActiveStreamsProvider";
import { IslandProvider } from "@/components/livedeck/IslandProvider";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <FollowProvider>
        <PlayerUiProvider>
          <CustomCategoriesProvider>
            <CategoryProvider>
              <ActiveStreamsProvider>
                <IslandProvider>{children}</IslandProvider>
              </ActiveStreamsProvider>
            </CategoryProvider>
          </CustomCategoriesProvider>
        </PlayerUiProvider>
      </FollowProvider>
    </ThemeProvider>
  );
}
