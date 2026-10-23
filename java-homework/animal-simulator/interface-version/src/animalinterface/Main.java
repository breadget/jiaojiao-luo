package animalinterface;

public class Main {
    public static void main(String[] args) {
        Simulator simulator = new Simulator();
        simulator.playSound(new Dog());
        simulator.playSound(new Cat());

        // 多态：接口引用可以指向任意实现类的对象
        Animal[] animals = { new Dog(), new Cat(), new Dog() };
        for (Animal animal : animals) {
            simulator.playSound(animal);
        }
    }
}
