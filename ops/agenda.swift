// agenda: __NOMBRE__'s Calendar.app events as JSON (read-only, EventKit).
// Usage: agenda [YYYY-MM-DD] [days]   (default: today, 14 days)
// Build: swiftc -O -o ~/GBRAIN/ops/bin/Agenda.app/Contents/MacOS/agenda ~/GBRAIN/ops/agenda.swift && codesign -s - --force ~/GBRAIN/ops/bin/Agenda.app
import EventKit
import Foundation

let store = EKEventStore()
let sem = DispatchSemaphore(value: 0)
var granted = false
store.requestFullAccessToEvents { ok, _ in granted = ok; sem.signal() }
sem.wait()
if !granted {
  print("{\"error\":\"Sin permiso para leer el Calendario (Ajustes del Sistema → Privacidad → Calendarios)\"}")
  exit(1)
}
let args = CommandLine.arguments
let day = DateFormatter(); day.dateFormat = "yyyy-MM-dd"; day.timeZone = .current
let stamp = DateFormatter(); stamp.dateFormat = "yyyy-MM-dd HH:mm"; stamp.timeZone = .current
let start = Calendar.current.startOfDay(for: args.count > 1 ? (day.date(from: args[1]) ?? Date()) : Date())
let days = args.count > 2 ? max(1, min(62, Int(args[2]) ?? 14)) : 14
let end = Calendar.current.date(byAdding: .day, value: days, to: start)!
let events = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: nil))
  .sorted { $0.startDate < $1.startDate }
  .map { ev -> [String: Any] in
    ["titulo": ev.title ?? "", "inicio": stamp.string(from: ev.startDate), "fin": stamp.string(from: ev.endDate),
     "todo_el_dia": ev.isAllDay, "calendario": ev.calendar.title, "lugar": ev.location ?? ""]
  }
let out: [String: Any] = ["desde": day.string(from: start), "dias": days, "zona": TimeZone.current.identifier, "eventos": events]
print(String(data: try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
