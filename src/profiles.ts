export const PROFILES = ["microservice"] as const;

export type Profile = (typeof PROFILES)[number];

export function parseProfile(value: string): Profile {
  if (PROFILES.includes(value as Profile)) {
    return value as Profile;
  }

  if (value === "app") {
    throw new Error(
      "The app profile has moved out of create-service. Use the private create-app template repositories instead."
    );
  }

  throw new Error(`Unknown profile: ${value}`);
}

export function exampleForProfile(_profile: Profile) {
  return {
    kind: "microservice",
    domain: "waitlist",
    label: "waitlist/launch service",
  };
}
