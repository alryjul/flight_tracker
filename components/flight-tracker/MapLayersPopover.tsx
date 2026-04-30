"use client";

import { Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";

// Why: toggle visibility for both basemap label categories AND our
// custom map overlays (home-base center point + concentric search
// radius rings — the "target view" / focus indicator). Grouped into
// one popover because they all share the same mental model: "what's
// rendering on the map." Label groupings + overlay layers live in
// MapCanvas where the visibility is actually applied; this component
// is just the UI for the toggles.
//
// Note on POI: Positron's POI coverage is sparse (only poi_stadium
// and poi_park are labeled in the style), and neither is visible at
// city-scale zoom. The toggle still drives setLayoutProperty
// correctly — it just has limited visible effect at common zooms.
export type MapLabelVisibility = {
  placeLabels: boolean;
  roadLabels: boolean;
  poiLabels: boolean;
  homeBaseIndicator: boolean;
};

export const DEFAULT_MAP_LABEL_VISIBILITY: MapLabelVisibility = {
  placeLabels: true,
  roadLabels: true,
  poiLabels: true,
  homeBaseIndicator: true
};

type MapLayersPopoverProps = {
  visibility: MapLabelVisibility;
  onVisibilityChange: (next: MapLabelVisibility) => void;
};

type ToggleSection = {
  heading: string;
  toggles: Array<{
    key: keyof MapLabelVisibility;
    label: string;
    description: string;
  }>;
};

const TOGGLE_SECTIONS: ToggleSection[] = [
  {
    heading: "Map labels",
    toggles: [
      {
        key: "placeLabels",
        label: "Place labels",
        description: "Cities, neighborhoods, regions"
      },
      {
        key: "roadLabels",
        label: "Road labels",
        description: "Street names, highway numbers"
      },
      {
        key: "poiLabels",
        label: "POI labels",
        description: "Stadiums, parks (sparse at city zoom)"
      }
    ]
  },
  {
    heading: "Map overlays",
    toggles: [
      {
        key: "homeBaseIndicator",
        label: "Home base",
        description: "Center point + search radius rings"
      }
    ]
  }
];

export function MapLayersPopover({
  visibility,
  onVisibilityChange
}: MapLayersPopoverProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-9 gap-1.5 bg-card px-2.5 shadow-md"
          aria-label="Toggle map labels"
        >
          <Layers className="size-4" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="left" align="end" className="w-64">
        <div className="grid gap-3">
          {TOGGLE_SECTIONS.map((section) => (
            <div key={section.heading} className="grid gap-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {section.heading}
              </p>
              <div className="grid gap-2.5">
                {section.toggles.map((toggle) => (
                  <div
                    key={toggle.key}
                    className="flex items-start justify-between gap-3"
                  >
                    <div className="grid gap-0.5">
                      <Label
                        htmlFor={`map-toggle-${toggle.key}`}
                        className="text-xs font-medium"
                      >
                        {toggle.label}
                      </Label>
                      <p className="text-[10px] text-muted-foreground">
                        {toggle.description}
                      </p>
                    </div>
                    <Switch
                      id={`map-toggle-${toggle.key}`}
                      checked={visibility[toggle.key]}
                      onCheckedChange={(checked) =>
                        onVisibilityChange({
                          ...visibility,
                          [toggle.key]: checked
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
