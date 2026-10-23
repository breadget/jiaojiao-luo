package animalabstract;

public class Main {
    public static void main(String[] args) {
        Simulator simulator = new Simulator();
        simulator.playSound(new Dog());
        simulator.playSound(new Cat());

        // 抽象类引用指向子类对象，同样是多态
        Animal[] animals = { new Dog(), new Cat() };
        for (Animal animal : animals) {
            simulator.playSound(animal);
            animal.show(); // 抽象类中的普通方法也可被子类对象使用
        }
    }
}
