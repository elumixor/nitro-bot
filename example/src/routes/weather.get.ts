import { tool } from "@elumixor/nitro-bot";
import { defineEventHandler, getQuery } from "h3";
import { z } from "zod";

export const definition = tool({
  name: "get_weather",
  description: "Get the current weather for a city. Returns temperature in Celsius.",
  input: { city: z.string().describe("The city name, e.g. 'Berlin'") },
});

const fakeForecast: Record<string, number> = {
  berlin: 18,
  london: 14,
  madrid: 27,
  tokyo: 22,
};

export default defineEventHandler((event) => {
  const { city } = getQuery(event) as { city?: string };
  const key = (city ?? "").toLowerCase();
  return { city: city ?? "", tempCelsius: fakeForecast[key] ?? 20 };
});
