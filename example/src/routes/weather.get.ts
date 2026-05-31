import { tool } from "@elumixor/nitro-bot";
import { handler } from "@elumixor/nitro-client/server";
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

export default handler({ query: definition.input }, ({ query, event }) => {
  console.log("[weather] direct invoke?", event.path, "bot:", event.context.bot);
  const key = query.city.toLowerCase();
  return { city: query.city, tempCelsius: fakeForecast[key] ?? 20 };
});
