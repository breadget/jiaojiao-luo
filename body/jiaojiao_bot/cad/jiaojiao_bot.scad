// Jiaojiao Bot: OpenBot DIY wheeled humanoid body kit
// Units: millimetres. Origin: centre of the stock OpenBot regular body_top.
// The stock top's STEP origin is (5, 10, 0); interface points are translated here.
// Export a part with: openscad -o part.stl -D 'part="adapter_frame"' jiaojiao_bot.scad

$fn = 40;
part = "assembly";

// Verified against body/diy/cad/regular_body/body_top.step.
frame_t = 5;
deck_z = 35.5; // body_bottom top (29.5) + stock body_top (6)
frame_outer_x = 103; // leaves a practical margin on a 220 mm print bed
corner_x = [-98, 98];
corner_y = [-71.175856, 71.175856];
phone_holes_x = [-53.5, -33.5];
phone_holes_y = 0;
torso_hole_x = [27, 57];
torso_hole_y = [-30, 30];
shell_outer_w = 214;
shell_outer_d = 150;
shell_inner_w = 198;
shell_inner_d = 134;

module beam2d(a, b, width) {
    hull() {
        translate(a) circle(d = width);
        translate(b) circle(d = width);
    }
}

module rounded_rect_2d(width, depth, radius) {
    hull() {
        for (x = [-width / 2 + radius, width / 2 - radius])
            for (y = [-depth / 2 + radius, depth / 2 - radius])
                translate([x, y]) circle(r = radius);
    }
}

module adapter_outline() {
    union() {
        // Four perimeter rails use the original body's corner fasteners.
        for (y = corner_y) beam2d([-frame_outer_x, y], [frame_outer_x, y], 8);
        for (x = corner_x) beam2d([x, -71.175856], [x, 71.175856], 8);

        // Open truss from the phone-mount interface to the torso foot.
        // The large centre remains open for the stock electronics and battery access.
        beam2d([-43.5, -71], [-43.5, -20], 8);
        beam2d([-43.5, 20], [-43.5, 71], 8);
        beam2d([-43.5, -20], [-43.5, 20], 36);
        beam2d([-27, -18], [22, -37], 8);
        beam2d([-27, 18], [22, 37], 8);
        beam2d([22, -37], [22, 37], 9);
        beam2d([22, -37], [62, -37], 9);
        beam2d([22, 37], [62, 37], 9);
        beam2d([62, -37], [62, 37], 9);
        // Flat bearing pad directly under the four torso-foot screws.
        translate([22, -38]) square([40, 76]);
        beam2d([62, -37], [98, -71], 8);
        beam2d([62, 37], [98, 71], 8);
    }
}

module adapter_frame() {
    difference() {
        linear_extrude(height = frame_t) adapter_outline();

        // Existing body_top corner holes: radius 3 mm in the source STEP.
        for (x = corner_x, y = corner_y)
            translate([x, y, -1]) cylinder(h = frame_t + 2, d = 6.6);

        // Existing phone_mount_bottom holes: 20 mm pitch, M3 clearance.
        for (x = phone_holes_x)
            translate([x, phone_holes_y, -1]) cylinder(h = frame_t + 2, d = 3.6);

        // Four new torso-support fasteners.
        for (x = torso_hole_x, y = torso_hole_y)
            translate([x, y, -1]) cylinder(h = frame_t + 2, d = 3.6);
    }
}

module base_shell() {
    // A clip-on fascia that hides the original body-top branding while keeping
    // the electronics and battery service opening accessible.
    difference() {
        linear_extrude(height = 18)
            rounded_rect_2d(shell_outer_w, shell_outer_d, 12);
        translate([0, 0, -1])
            linear_extrude(height = 20)
                rounded_rect_2d(shell_inner_w, shell_inner_d, 8);

        // The existing four M3 corner screws pass through the fascia.
        for (x = corner_x, y = corner_y)
            translate([x, y, -1]) cylinder(h = 20, d = 6.8);
    }
}

module logo_badge() {
    // Flat printable badge. Assembly preview rotates it onto the original
    // body-top side where the stock OpenBot mark is located.
    union() {
        linear_extrude(height = 3)
            rounded_rect_2d(78, 18, 3);
        translate([0, 0, 3])
            linear_extrude(height = 1)
                text("JiaoJiao-Luo", size = 8, halign = "center", valign = "center",
                     font = "Arial:style=Bold");
    }
}

// Map a 2D (width, height) profile into the robot's Y-Z plane and extrude on X.
module yz_prism(points, x0, thickness) {
    multmatrix(m = [
        [0, 0, 1, x0],
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 0, 1]
    ])
        linear_extrude(height = thickness)
            polygon(points = points);
}

function torso_profile() = [
    // Rounded shoulder line, tapered waist and a short neck for the phone head.
    [-30, 5], [-42, 16], [-44, 68], [-56, 86], [-51, 98],
    [-36, 105], [-20, 101], [-14, 94], [-14, 108], [14, 108],
    [14, 94], [20, 101], [36, 105], [51, 98], [56, 86],
    [44, 68], [42, 16], [30, 5]
];

module torso_support() {
    difference() {
        union() {
            // Horizontal foot and upright torso web.
            translate([20, -42, 0]) cube([50, 84, 5]);
            yz_prism(torso_profile(), 20, 6);
            // A thin rear armor panel closes the open frame into a finished torso.
            yz_prism(torso_profile(), 26, 4);

            // Tapered side fairings brace the upright web and read as a waist.
            for (side = [-1, 1])
                translate([0, side > 0 ? 37 : -29, 5])
                    rotate([90, 0, 0])
                        linear_extrude(height = 8)
                            polygon(points = [[24, 0], [54, 0], [57, 7], [51, 20], [41, 34], [24, 45]]);
        }

        // Foot bolts align to the four dedicated adapter-frame holes.
        for (x = torso_hole_x, y = torso_hole_y)
            translate([x, y, -1]) cylinder(h = 8, d = 3.6);

        // Shell and arms share the M3 mounting pattern in the upright web.
        for (y = [-30, 30], z = [35, 72])
            translate([18, y, z]) rotate([0, 90, 0]) cylinder(h = 18, d = 3.2);
        for (side = [-1, 1])
            for (p = [[44, 96], [54, 88]])
                translate([18, side * p[0], p[1]])
                    rotate([0, 90, 0]) cylinder(h = 18, d = 3.2);
    }
}

module chest_shell() {
    shell_profile = [
        [-27, 22], [-35, 25], [-42, 35], [-43, 72], [-39, 83],
        [-30, 91], [-15, 94], [0, 91], [15, 94], [30, 91],
        [39, 83], [43, 72], [42, 35], [35, 25], [27, 22]
    ];
    badge_profile = [
        [-12, 38], [-16, 43], [-16, 67], [-12, 73],
        [12, 73], [16, 67], [16, 43], [12, 38]
    ];
    difference() {
        union() {
            // Deep outer armor plus a raised central faceplate.
            yz_prism(shell_profile, 12.5, 7.5);
            yz_prism(badge_profile, 9.5, 3.5);
        }
        for (y = [-30, 30], z = [35, 72])
            translate([8, y, z]) rotate([0, 90, 0]) cylinder(h = 14, d = 3.4);
    }
}

module arm(side = 1) {
    arm_profile = [
        [39, 100], [45, 108], [59, 109], [69, 103], [75, 92],
        [74, 78], [68, 64], [66, 50], [58, 44], [50, 48],
        [48, 58], [54, 67], [55, 80], [49, 89], [39, 91]
    ];
    cuff_profile = [
        [54, 48], [62, 52], [68, 63], [68, 73],
        [61, 78], [54, 73], [58, 64]
    ];
    points = [for (p = arm_profile) [side * p[0], p[1]]];
    difference() {
        union() {
            yz_prism(points, 14, 6);
            yz_prism([for (p = cuff_profile) [side * p[0], p[1]]], 11, 3);
        }
        for (p = [[44, 96], [54, 88]])
            translate([10, side * p[0], p[1]])
                rotate([0, 90, 0]) cylinder(h = 13, d = 3.4);
    }
}

module stock_chassis_preview() {
    color("#59636e")
        translate([-5, -10, 0])
            import("../../diy/cad/regular_body/body_bottom.stl");
    color("#737e88")
        translate([-5, -10, 29.5])
            import("../../diy/cad/regular_body/body_top.stl");

    // Wheels are visual stand-ins; the stock four TT motors and wheels are reused.
    color("#20252b")
        for (x = [-82, 82], y = [-66, 66])
            translate([x, y, 26]) rotate([90, 0, 0])
                cylinder(h = 24, d = 65, center = true);
}

module stock_phone_mount_preview() {
    // The stock mount's two M3 holes are (23, 7.5, 11) and (23, 27.5, 11).
    // This matrix places them on the verified phone interface at deck_z.
    color("#4669a8")
        multmatrix(m = [
            [0, 1, 0, -61],
            [0, 0, 1, -11],
            [1, 0, 0, 12.5],
            [0, 0, 0, 1]
        ]) {
            import("../../phone_mount/phone_mount_bottom.stl");
            color("#5e83c2")
                import("../../phone_mount/phone_mount_top.stl");
        }
}

module phone_preview() {
    // Visual only. The real build reuses the stock mount and a phone.
    color("#18232e")
        translate([-57, -39, deck_z + 22]) cube([12, 78, 160]);
    color("#2f90a8")
        translate([-58.5, -35, deck_z + 28]) cube([1.5, 70, 148]);
    color("#111820")
        translate([-59, -14, deck_z + 178]) cube([2, 28, 4]); // camera-window marker
}

module assembly_preview() {
    stock_chassis_preview();
    translate([0, 0, deck_z])
        color("#3b82a0") adapter_frame();
    translate([0, 0, deck_z - 1])
        color("#1f5663") base_shell();
    color("#1f5663")
        multmatrix(m = [
            [0, 0, -1, -118],
            [1, 0, 0, 5],
            [0, 1, 0, deck_z + 3.5],
            [0, 0, 0, 1]
        ]) logo_badge();
    color("#1f5663")
        translate([-71, -30, deck_z + 5.5]) logo_badge();
    stock_phone_mount_preview();
    translate([0, 0, deck_z + frame_t]) {
        color("#d9e1e8") torso_support();
        color("#ef8e45") chest_shell();
        color("#738293") {
            arm(-1);
            arm(1);
        }
    }
    phone_preview();
}

if (part == "adapter_frame") adapter_frame();
else if (part == "base_shell") base_shell();
else if (part == "logo_badge") logo_badge();
else if (part == "torso_support") torso_support();
else if (part == "chest_shell") chest_shell();
else if (part == "arm_left") arm(-1);
else if (part == "arm_right") arm(1);
else if (part == "assembly") assembly_preview();
else assert(false, str("Unknown part: ", part));
