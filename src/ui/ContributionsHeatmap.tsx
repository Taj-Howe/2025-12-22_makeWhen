import { useEffect, useMemo, useState, type FC } from "react";
import type { Scope } from "../domain/scope";
import { query } from "../data/api";
import { AppSelect } from "./controls";
import { addDays, startOfDay } from "./dateWindow";

type ContributionDay = {
  day: string;
  completed_count: number;
};

type ContributionsResult = {
  days: ContributionDay[];
  meta: { max_count: number };
};

type ContributionsHeatmapProps = {
  scope: Scope;
  refreshToken: number;
};

const RANGE_OPTIONS = [30, 90, 365] as const;

const formatLocalDayString = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const parseLocalDayString = (value: string) => {
  const [year, month, day] = value.split("-").map((part) => Number(part));
  return new Date(year, month - 1, day);
};

const DAY_LABEL = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

const MONTH_LABEL = new Intl.DateTimeFormat(undefined, { month: "short" });

const WEEKDAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", ""];

const ContributionsHeatmap: FC<ContributionsHeatmapProps> = ({
  scope,
  refreshToken,
}) => {
  const [dayCount, setDayCount] = useState<number>(90);
  const [data, setData] = useState<ContributionsResult>({
    days: [],
    meta: { max_count: 0 },
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startDate = useMemo(() => {
    const today = startOfDay(new Date());
    return addDays(today, -(dayCount - 1));
  }, [dayCount]);

  const dayStartLocal = useMemo(
    () => formatLocalDayString(startDate),
    [startDate]
  );

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    setError(null);
    query<ContributionsResult>("contributions_range", {
      scope,
      day_start_local: dayStartLocal,
      day_count: dayCount,
      includeSubtasks: true,
      includeMilestones: false,
      includeProjects: false,
    })
      .then((result) => {
        if (!isMounted) {
          return;
        }
        setData(result);
      })
      .catch((err) => {
        if (!isMounted) {
          return;
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      })
      .finally(() => {
        if (isMounted) {
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [dayCount, dayStartLocal, refreshToken, scope]);

  const offset = useMemo(() => {
    const day = startDate.getDay();
    return (day + 6) % 7;
  }, [startDate]);

  const cells = useMemo(() => {
    const blanks = Array.from({ length: offset }, () => null);
    return [...blanks, ...data.days];
  }, [data.days, offset]);

  const weeks = useMemo(() => Math.ceil(cells.length / 7), [cells.length]);

  const monthLabels = useMemo(() => {
    let lastMonth: number | null = null;
    return Array.from({ length: weeks }, (_, weekIndex) => {
      const weekSlice = cells.slice(weekIndex * 7, weekIndex * 7 + 7);
      const firstDay = weekSlice.find((day) => day !== null) as
        | ContributionDay
        | null;
      if (!firstDay) {
        return "";
      }
      const date = parseLocalDayString(firstDay.day);
      const month = date.getMonth();
      if (lastMonth === month) {
        return "";
      }
      lastMonth = month;
      return MONTH_LABEL.format(date);
    });
  }, [cells, weeks]);

  const maxCount = data.meta.max_count;
  const getLevel = (count: number) => {
    if (!maxCount || count <= 0) {
      return 0;
    }
    const ratio = count / maxCount;
    if (ratio <= 0.25) return 1;
    if (ratio <= 0.5) return 2;
    if (ratio <= 0.75) return 3;
    return 4;
  };

  return (
    <div className="heatmap">
      <div className="heatmap-header">
        <div className="heatmap-title">Contributions</div>
        <label className="heatmap-range">
          Range
          <AppSelect
            value={String(dayCount)}
            onChange={(value) => setDayCount(Number(value))}
            options={RANGE_OPTIONS.map((value) => ({
              value: String(value),
              label: `${value} days`,
            }))}
          />
        </label>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {loading ? <div className="dashboard-empty">Loading…</div> : null}
      <div className="heatmap-grid-wrap">
        <div className="heatmap-months">
          {monthLabels.map((label, index) => (
            <div key={`month-${index}`} className="heatmap-month">
              {label}
            </div>
          ))}
        </div>
        <div className="heatmap-body">
          <div className="heatmap-weekdays">
            {WEEKDAY_LABELS.map((label, index) => (
              <div key={`weekday-${index}`} className="heatmap-weekday">
                {label}
              </div>
            ))}
          </div>
          <div className="heatmap-grid">
            {cells.map((day, index) => {
              if (!day) {
                return <div key={`empty-${index}`} className="heatmap-cell" />;
              }
              const level = getLevel(day.completed_count);
              const date = parseLocalDayString(day.day);
              const label = `${
                day.completed_count
              } completed on ${DAY_LABEL.format(date)}`;
              return (
                <div
                  key={day.day}
                  className={`heatmap-cell heatmap-level-${level}`}
                  title={label}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ContributionsHeatmap;
