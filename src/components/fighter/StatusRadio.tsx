"use client";

import { useTranslations } from "next-intl";

import { FilterRadioGroup } from "@/components/fighter/FilterRadioGroup";

type StatusValue = "all" | "active" | "inactive" | "retired";

const STATUSES: ReadonlyArray<{
  id: StatusValue;
  key: "statusActive" | "statusInactive" | "statusAll";
}> = [
  { id: "active", key: "statusActive" },
  { id: "inactive", key: "statusInactive" },
  { id: "all", key: "statusAll" },
];

interface StatusRadioProps {
  value: StatusValue;
  onChange: (value: StatusValue) => void;
}

export function StatusRadio({ value, onChange }: StatusRadioProps) {
  const t = useTranslations("catalog");
  return (
    <FilterRadioGroup
      value={value}
      onChange={onChange}
      ariaLabel={t("filterStatus")}
      className="grid grid-cols-3 gap-1"
      options={STATUSES.map((s) => ({ id: s.id, label: t(s.key) }))}
    />
  );
}
