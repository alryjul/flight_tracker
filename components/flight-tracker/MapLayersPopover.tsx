"use client";

import { Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
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
  // Why: split the old "home base" toggle into its two separable
  // affordances — the centerpoint icon and the proximity rings — so
  // users can keep one without the other (e.g., hide the rings to
  // see the underlying map but keep the icon as a "you are here"
  // anchor).
  homeBaseIcon: boolean;
  homeBaseRings: boolean;
  flightTrail: boolean;
  // Why: scalar (0–1) multiplier applied to road / highway line
  // opacity in dark mode only. Dark Matter's road styling competes
  // with our flight icons; the slider lets the user dial it down to
  // taste. 1 = no dim (basemap default), 0 = roads invisible.
  // Light mode (Positron) ignores this — its roads are already
  // low-contrast on the cream background.
  roadDimDark: number;
};

export const DEFAULT_MAP_LABEL_VISIBILITY: MapLabelVisibility = {
  placeLabels: true,
  roadLabels: true,
  poiLabels: true,
  homeBaseIcon: true,
  homeBaseRings: true,
  flightTrail: true,
  roadDimDark: 0.5
};

type MapLayersPopoverProps = {
  visibility: MapLabelVisibility;
  onVisibilityChange: (next: MapLabelVisibility) => void;
};

// Why: only boolean-valued keys can be wired to Switch toggles. The
// roadDimDark slider gets its own bespoke control below — keep the
// generic toggle config strictly typed to avoid passing a number into
// a Switch's `checked` prop by accident.
type BooleanKeys<T> = {
  [K in keyof T]: T[K] extends boolean ? K : never;
}[keyof T];

type ToggleSection = {
  heading: string;
  toggles: Array<{
    key: BooleanKeys<MapLabelVisibility>;
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
        description: "Stadiums, parks, oceans, lakes, rivers"
      }
    ]
  },
  {
    heading: "Map overlays",
    toggles: [
      {
        key: "homeBaseIcon",
        label: "Home base icon",
        description: "House marker at the center point"
      },
      {
        key: "homeBaseRings",
        label: "Search radius rings",
        description: "Concentric proximity rings around home base"
      },
      {
        key: "flightTrail",
        label: "Flight trail",
        description: "Track line behind the selected or nearest flight"
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

          {/* Why: bespoke slider section — Slider's value semantics
              don't fit the boolean-toggle shape used above, so it
              gets its own block. Slider takes/returns number arrays
              (radix supports multi-thumb), so we wrap the scalar
              roadDimDark in/out as a single-element array. */}
          <div className="grid gap-2">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Map appearance
            </p>
            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <Label
                  htmlFor="map-toggle-roadDimDark"
                  className="text-xs font-medium"
                >
                  Road dim (dark mode)
                </Label>
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {Math.round(visibility.roadDimDark * 100)}%
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Lower = quieter road / highway lines on the dark
                basemap. No effect in light mode.
              </p>
              <Slider
                id="map-toggle-roadDimDark"
                min={0}
                max={1}
                step={0.05}
                value={[visibility.roadDimDark]}
                onValueChange={([next]) =>
                  onVisibilityChange({
                    ...visibility,
                    roadDimDark: next ?? visibility.roadDimDark
                  })
                }
              />
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
