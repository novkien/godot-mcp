extends SceneTree

class Emitter extends Node:
	signal empty
	signal one(value)
	signal many(a, b, c, d)
	signal nine(a, b, c, d, e, f, g, h, i)

var bridge: Node
var emitter: Emitter
var cases: int = 0

func check(ok: bool, label: String) -> void:
	if not ok:
		push_error("FAIL: " + label)
		quit(1)
		assert(ok, label)
	cases += 1

func wait_for_signal(name: String, values: Array) -> Dictionary:
	bridge.responses.clear()
	var emission: Array = [name]
	emission.append_array(values)
	create_timer(0.02).timeout.connect(func(): emitter.callv("emit_signal", emission))
	await bridge._cmd_await_signal({"node_path": "/root/Emitter", "signal_name": name, "timeout": 0.5})
	check(bridge.responses.size() == 1, name + " one response")
	check(emitter.get_signal_connection_list(name).is_empty(), name + " callback removed")
	return bridge.responses[0]

func _initialize() -> void:
	call_deferred("run")

func run() -> void:
	bridge = load("res://bridge.gd").new()
	root.add_child(bridge)
	emitter = Emitter.new()
	emitter.name = "Emitter"
	root.add_child(emitter)
	var zero: Dictionary = await wait_for_signal("empty", [])
	check(zero.get("received") == true and zero.get("args") == [], "zero arguments")
	var one: Dictionary = await wait_for_signal("one", [42])
	check(one.get("args") == [42], "one argument")
	var many: Dictionary = await wait_for_signal("many", ["Việt ✓", Vector2(2, 3), {"nested": [true, null]}, 7])
	check(many.get("args") == ["Việt ✓", {"x": 2.0, "y": 3.0}, {"nested": [true, null]}, 7], "payload fidelity")
	var nine: Dictionary = await wait_for_signal("nine", [1, 2, 3, 4, 5, 6, 7, 8, 9])
	check(nine.get("args") == [1, 2, 3, 4, 5, 6, 7, 8, 9], "no eight-argument cap")
	bridge.responses.clear()
	await bridge._cmd_await_signal({"node_path": "/root/Emitter", "signal_name": "one", "timeout": 0.01})
	check(bridge.responses[0].get("timeout") == true, "real timeout")
	check(emitter.get_signal_connection_list("one").is_empty(), "timeout callback removed")
	bridge.responses.clear()
	await bridge._cmd_await_signal({"node_path": "/root/missing", "signal_name": "one"})
	check(bridge.responses[0].has("error"), "missing node")
	bridge.responses.clear()
	await bridge._cmd_await_signal({"node_path": "/root/Emitter", "signal_name": "missing"})
	check(bridge.responses[0].has("error"), "missing signal")
	bridge.responses.clear()
	await bridge._cmd_await_signal({"node_path": "/root/Emitter", "signal_name": "one", "timeout": -1})
	check(bridge.responses[0].has("error"), "invalid timeout")
	bridge.responses.clear()
	Engine.time_scale = 0.01
	var before: int = Time.get_ticks_msec()
	await bridge._cmd_await_signal({"node_path": "/root/Emitter", "signal_name": "one", "timeout": 0.02})
	Engine.time_scale = 1.0
	check(bridge.responses[0].get("timeout") == true and Time.get_ticks_msec() - before < 500, "timeout independent of game time scale")
	bridge.responses.clear()
	bridge._client = StreamPeerTCP.new()
	await bridge._cmd_await_signal({"node_path": "/root/Emitter", "signal_name": "one", "timeout": 1})
	check(bridge.responses.is_empty() and emitter.get_signal_connection_list("one").is_empty(), "disconnected transport cleanup")
	bridge._client = null
	bridge.responses.clear()
	bridge._current_id = 10
	create_timer(0.02).timeout.connect(func(): bridge._current_id = 11)
	await bridge._cmd_await_signal({"node_path": "/root/Emitter", "signal_name": "one", "timeout": 1})
	check(bridge.responses.is_empty() and bridge._current_id == 11, "replacement request untouched")
	check(emitter.get_signal_connection_list("one").is_empty(), "cancel callback removed")
	bridge.responses.clear()
	create_timer(0.02).timeout.connect(func(): emitter.queue_free())
	await bridge._cmd_await_signal({"node_path": "/root/Emitter", "signal_name": "one", "timeout": 1})
	check(bridge.responses[0].has("error"), "freed source explicit error")
	print("SIGNAL_REGRESSIONS_PASS checks=", cases)
	quit()
