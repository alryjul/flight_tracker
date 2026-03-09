export function milesToLatitudeDelta(miles: number) {
  return miles / 69;
}

export function milesToLongitudeDelta(miles: number, latitude: number) {
  return miles / (Math.cos((latitude * Math.PI) / 180) * 69.172);
}

export function distanceBetweenPointsMiles(input: {
  fromLatitude: number;
  fromLongitude: number;
  toLatitude: number;
  toLongitude: number;
}) {
  const earthRadiusMiles = 3958.8;
  const latitudeDeltaRadians =
    ((input.toLatitude - input.fromLatitude) * Math.PI) / 180;
  const longitudeDeltaRadians =
    ((input.toLongitude - input.fromLongitude) * Math.PI) / 180;
  const fromLatitudeRadians = (input.fromLatitude * Math.PI) / 180;
  const toLatitudeRadians = (input.toLatitude * Math.PI) / 180;

  const haversine =
    Math.sin(latitudeDeltaRadians / 2) ** 2 +
    Math.cos(fromLatitudeRadians) *
      Math.cos(toLatitudeRadians) *
      Math.sin(longitudeDeltaRadians / 2) ** 2;

  return 2 * earthRadiusMiles * Math.asin(Math.sqrt(haversine));
}

export function isWithinBoundingBox(input: {
  latitude: number;
  longitude: number;
  centerLatitude: number;
  centerLongitude: number;
  radiusMiles: number;
}) {
  const latDelta = milesToLatitudeDelta(input.radiusMiles);
  const lonDelta = milesToLongitudeDelta(input.radiusMiles, input.centerLatitude);

  return (
    input.latitude >= input.centerLatitude - latDelta &&
    input.latitude <= input.centerLatitude + latDelta &&
    input.longitude >= input.centerLongitude - lonDelta &&
    input.longitude <= input.centerLongitude + lonDelta
  );
}
