import { describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers/test-app.js";
import { InMemoryAppointmentRepository } from "../src/infrastructure/memory-repositories.js";

describe("GET /api/appointments/:id", () => {
  it(
    "returns 200 with the appointment for a known id",
    async () => {
      const appointmentsRepo = new InMemoryAppointmentRepository();
      const appt = await appointmentsRepo.create({
        leadId: "11111111-1111-1111-1111-111111111111",
        status: "BOOKED",
        startsAt: new Date("2026-03-02T15:00:00.000Z"),
        endsAt: new Date("2026-03-02T15:30:00.000Z"),
        timezone: "America/Mexico_City",
      });
      const app = await buildTestApp({ appointmentsRepo });
      const res = await app.inject({ method: "GET", url: `/api/appointments/${appt.id}` });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(appt.id);
      expect(res.json().status).toBe("BOOKED");
    },
    // buildApp() imports googleapis (huge type surface); under full-suite parallel load the
    // first buildApp() call in a worker can occasionally exceed vitest's 5s default.
    15000,
  );

  it("returns 404 for a well-formed but unknown UUID", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/appointments/00000000-0000-0000-0000-000000000000" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "APPOINTMENT_NOT_FOUND" });
  });

  it("returns 400 for an invalid UUID", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/appointments/not-a-uuid" });
    expect(res.statusCode).toBe(400);
  });
});
