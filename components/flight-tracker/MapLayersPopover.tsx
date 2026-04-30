"use client";

import { Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";

// Why: Carto Positron / Dark Matter expose dozens of labeled symbol
// layers. We group them into a few user-meaningful categories so a
// single toggle hides the right cluster — "Place labels" covers
// city / town / neighborhood names, "Road labels" covers street and
// highway names, "POI labels" covers business / airport / transit
// labels. Label groupings live in MapCanvas where the visibility is
// actually applied; this component is just the UI for the toggles.
//
// Note on POI: Positron's POI coverage is sparse (only poi_stadium
// and poi_park are labeled in the style), and neither is visible at
// city-scale zoom. The toggle still drives setLayoutProperty
// correctly — it just has limited visible effect at common zooms.
export type MapLabelVisibility = {
  placeLabels: boolean;
  roadLabels: boolean;
  poiLabels: boolean;
};

export const DEFAULT_MAP_LABEL_VISIBILITY: MapLabelVisibility = {
  placeLabels: true,
  roadLabels: true,
  poiLabels: true
};

type MapLayersPopoverProps = {
  visibility: MapLabelVisibility;
  onVisibilityChange: (next: MapLabelVisibility) => void;
};

const TOGGLES: Array<{
  key: keyof MapLabelVisibility;
  label: string;
  description: string;
}> = [
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
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Map labels
            </p>
            <p className="text-xs text-muted-foreground">
              Hide categories that crowd the map.
            </p>
          </div>
          <div className="grid gap-2.5">
            {TOGGLES.map((toggle) => (
              <div
                key={toggle.key}
                className="flex items-start justify-between gap-3"
              >
                <div className="grid gap-0.5">
                  <Label htmlFor={`map-toggle-${toggle.key}`} className="text-xs font-medium">
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
      </PopoverContent>
    </Popover>
  );
}
