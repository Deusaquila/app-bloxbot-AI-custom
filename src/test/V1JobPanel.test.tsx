import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "@/types/desktop";
import type { Job } from "@/types/job";

const controls = vi.hoisted(() => ({
  pickV1Asset: vi.fn(),
  runV1Job: vi.fn(),
  listV1Jobs: vi.fn(),
  selected: { key: "explicit-studio-id", label: "Disposable PlaceTest" },
}));

vi.mock("@/providers/StudioTargetProvider", () => ({
  useStudioTargetOptional: () => ({ selected: controls.selected, status: "ready" }),
}));

import V1JobPanel from "@/components/V1JobPanel";

const completedJob = {
  id: "11111111-1111-4111-8111-111111111111",
  state: "COMPLETED",
  requirements: [
    { id: "color", status: "PASSED" },
    { id: "scale", status: "PASSED" },
  ],
} as Job;

describe("V1 desktop asset job panel", () => {
  beforeEach(() => {
    controls.pickV1Asset.mockReset();
    controls.runV1Job.mockReset();
    controls.listV1Jobs.mockReset();
    controls.listV1Jobs.mockResolvedValue([]);
    Object.defineProperty(window, "bloxbot", {
      configurable: true,
      value: {
        pickV1Asset: controls.pickV1Asset,
        runV1Job: controls.runV1Job,
        listV1Jobs: controls.listV1Jobs,
      } as unknown as DesktopApi,
    });
  });

  it("sends the chosen FBX and explicit Studio ID through the desktop API", async () => {
    controls.pickV1Asset.mockResolvedValue("C:\\fixtures\\horse.fbx");
    controls.runV1Job.mockResolvedValue(completedJob);
    render(<V1JobPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Asset job" }));
    const run = screen.getByRole("button", { name: "Run asset job" });
    expect(run).toBeDisabled();
    expect(screen.getByText(/Target: Disposable PlaceTest/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Choose FBX" }));
    await screen.findByText("C:\\fixtures\\horse.fbx");
    fireEvent.change(screen.getByRole("textbox", { name: "Roblox creator user ID" }), {
      target: { value: "4974439157" },
    });
    expect(run).toBeEnabled();
    fireEvent.click(run);

    await waitFor(() =>
      expect(controls.runV1Job).toHaveBeenCalledWith({
        sourcePath: "C:\\fixtures\\horse.fbx",
        studioId: "explicit-studio-id",
        creatorId: "4974439157",
      }),
    );
    expect(await screen.findByText("2/2 requirements passed")).toBeVisible();
    expect(screen.getByText(/COMPLETED/)).toBeVisible();
  });

  it("shows a rejected desktop call without claiming job completion", async () => {
    controls.pickV1Asset.mockResolvedValue("C:\\fixtures\\horse.fbx");
    controls.runV1Job.mockRejectedValue(new Error("Asset job could not finish"));
    render(<V1JobPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Asset job" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose FBX" }));
    await screen.findByText("C:\\fixtures\\horse.fbx");
    fireEvent.change(screen.getByRole("textbox", { name: "Roblox creator user ID" }), {
      target: { value: "4974439157" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run asset job" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Asset job could not finish");
    expect(screen.queryByText("COMPLETED")).not.toBeInTheDocument();
  });
});
