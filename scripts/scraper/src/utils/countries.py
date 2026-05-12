from __future__ import annotations

# Common locations that appear on UFCStats event pages, mapped to ISO 3166-1 alpha-2.
COUNTRY_MAP: dict[str, str] = {
    "USA": "US",
    "United States": "US",
    "Brazil": "BR",
    "Russia": "RU",
    "England": "GB",
    "United Kingdom": "GB",
    "Scotland": "GB",
    "Wales": "GB",
    "Northern Ireland": "GB",
    "Ireland": "IE",
    "Australia": "AU",
    "Canada": "CA",
    "Mexico": "MX",
    "Japan": "JP",
    "China": "CN",
    "South Korea": "KR",
    "Korea": "KR",
    "Philippines": "PH",
    "Singapore": "SG",
    "United Arab Emirates": "AE",
    "UAE": "AE",
    "Saudi Arabia": "SA",
    "Germany": "DE",
    "Netherlands": "NL",
    "Spain": "ES",
    "Italy": "IT",
    "France": "FR",
    "Sweden": "SE",
    "Poland": "PL",
    "Norway": "NO",
    "Argentina": "AR",
    "Chile": "CL",
    "Colombia": "CO",
    "Peru": "PE",
    "Venezuela": "VE",
    "Uruguay": "UY",
    "New Zealand": "NZ",
    "South Africa": "ZA",
    "Kazakhstan": "KZ",
    "Kyrgyzstan": "KG",
    "Uzbekistan": "UZ",
    "Tajikistan": "TJ",
    "Belarus": "BY",
    "Ukraine": "UA",
    "Moldova": "MD",
    "Georgia": "GE",
    "Armenia": "AM",
    "Azerbaijan": "AZ",
    "Iran": "IR",
    "Israel": "IL",
    "Turkey": "TR",
    "Croatia": "HR",
    "Slovakia": "SK",
    "Czech Republic": "CZ",
    "Romania": "RO",
    "Bulgaria": "BG",
    "Lithuania": "LT",
    "Latvia": "LV",
    "Estonia": "EE",
    "Finland": "FI",
    "Denmark": "DK",
    "Belgium": "BE",
    "Switzerland": "CH",
    "Austria": "AT",
    "Hungary": "HU",
    "Portugal": "PT",
    "Greece": "GR",
    "Iceland": "IS",
    "Indonesia": "ID",
    "Thailand": "TH",
    "Vietnam": "VN",
    "India": "IN",
    "Pakistan": "PK",
    "Nigeria": "NG",
    "Cameroon": "CM",
    "Dagestan": "RU",
}


def map_country(value: str | None) -> str | None:
    """Take a free-text location ('Newark, New Jersey, USA') and extract a country code.

    Falls back to None when the last token isn't recognized — we prefer NULL over a wrong guess.
    """
    if not value:
        return None
    parts = [p.strip() for p in value.split(",") if p.strip()]
    if not parts:
        return None
    last = parts[-1]
    return COUNTRY_MAP.get(last)
