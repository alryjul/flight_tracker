"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type AreaDraft = { latitude: string; longitude: string; radiusMiles: string };

type AreaConfigPopoverProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  radiusMiles: number;
  areaDraft: AreaDraft;
  areaError: string | null;
  isLocating: boolean;
  onDraftChange: (updater: (draft: AreaDraft) => AreaDraft) => void;
  onUseMapCenter: () => void;
  onUseLocation: () => void;
  onApply: () => void;
};

export function AreaConfigPopover({
  open,
  onOpenChange,
  radiusMiles,
  areaDraft,
  areaError,
  isLocating,
  onDraftChange,
  onUseMapCenter,
  onUseLocation,
  onApply
}: AreaConfigPopoverProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="w-full justify-between">
          <span className="text-xs text-muted-foreground">Area</span>
          <strong className="text-xs tabular-nums">{radiusMiles} mi</strong>
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72">
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1">
              <Label htmlFor="area-lat" className="text-[10px] uppercase tracking-wider">
                Latitude
              </Label>
              <Input
                className="h-8 tabular-nums"
                id="area-lat"
                onChange={(event) =>
                  onDraftChange((currentDraft) => ({
                    ...currentDraft,
                    latitude: event.target.value
                  }))
                }
                type="text"
                value={areaDraft.latitude}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="area-lon" className="text-[10px] uppercase tracking-wider">
                Longitude
              </Label>
              <Input
                className="h-8 tabular-nums"
                id="area-lon"
                onChange={(event) =>
                  onDraftChange((currentDraft) => ({
                    ...currentDraft,
                    longitude: event.target.value
                  }))
                }
                type="text"
                value={areaDraft.longitude}
              />
            </div>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="area-rad" className="text-[10px] uppercase tracking-wider">
              Radius (miles)
            </Label>
            <Input
              className="h-8 tabular-nums"
              id="area-rad"
              onChange={(event) =>
                onDraftChange((currentDraft) => ({
                  ...currentDraft,
                  radiusMiles: event.target.value
                }))
              }
              type="text"
              value={areaDraft.radiusMiles}
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button onClick={onUseMapCenter} size="sm" type="button" variant="outline">
              Use map center
            </Button>
            <Button onClick={onUseLocation} size="sm" type="button" variant="outline">
              {isLocating ? "Locating..." : "My location"}
            </Button>
            <Button className="ml-auto" onClick={onApply} size="sm" type="button">
              Apply
            </Button>
          </div>
          {areaError ? <p className="text-xs text-destructive">{areaError}</p> : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
